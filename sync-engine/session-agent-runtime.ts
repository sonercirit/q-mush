import {
  readAgentAttachments,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import { throwIfAgentAborted } from "../shared/agent-loop.ts";
import {
  isAgentSessionToolName,
  isSessionAgentToolName,
  readAgentSessionToolNames,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import { createUuidV7 } from "../shared/ids.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import {
  type RunnerCommandBroker,
  type RunnerCommandOutputDelta,
} from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  SessionRuntimePendingComponent,
} from "../shared/session-model.ts";
import {
  toolExecutionLimitSeconds,
  type ToolSettings,
} from "../shared/tool-limits.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";
import type { ActiveSessionTools } from "./active-session-tools.ts";
import { forEachAssistantToolCall } from "./agent-conversation.ts";
import { estimateAgentStepCost } from "./agent-cost.ts";
import type { ProviderRequestState } from "./agent-model-options.ts";
import { createAgentSkills } from "./agent-skills.ts";
import { isAskQuestionsPause } from "./ask-questions-pause.ts";
import { explainAttachment } from "./attachment-fallback-model.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import { activeToolTracker } from "./session-active-tool-tracking.ts";
import { loadSessionAgentFile } from "./session-agent-file.ts";
import { runCompactingAgentLoop } from "./session-agent-loop.ts";
import {
  executeForSession,
  isRestartHandoffError,
  markSessionStepStart,
  recordCompaction,
  recordRuntimeUsage,
  throwIfRestartRequested,
  writeRuntime,
} from "./session-agent-runtime-state.ts";

import {
  createSessionAgentModels,
  type AgentModelFactory,
  type SessionAgentModels,
} from "./session-agent-models.ts";
import { currentExecutionTools } from "./session-agent-tool-authority.ts";
import {
  executeAuthorizedRuntimeTool,
  type AgentToolDispatcher,
} from "./session-agent-tool-execution.ts";
import {
  executeSessionAgentTool,
  type SessionAgentToolActions,
} from "./session-agent-tools.ts";
import { agentStepUsage, compactionUsage } from "./session-compaction-usage.ts";
import {
  discoverCurrentSessionModel,
  sessionRequestMetadata,
} from "./session-current-model.ts";
import { withLoadingDeadline } from "./session-loading-deadline.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";
import { SessionRecorder } from "./session-recorder.ts";
import { sessionRuntimeConversation } from "./session-runtime-conversation.ts";
import { executeSessionSleepTool } from "./session-sleep-tool.ts";
import { waitForSessionSteeringInput } from "./session-steering-wakeup.ts";
import type { SessionStore } from "./session-store.ts";
import { boundSessionToolOutput } from "./session-tool-output.ts";
import { ToolStreamPublisher } from "./tool-stream-publisher.ts";

export interface SessionAgentRuntimeDependencies extends AttachmentFallbackRuntimeResources {
  readonly activeTools: ActiveSessionTools;
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly broker: RunnerCommandBroker;
  readonly credential: ProviderCredentialAccess;
  readonly currentTools?: () => readonly AgentSessionToolName[] | undefined;
  readonly continuous: boolean;
  readonly detail: AgentSessionDetail;
  readonly hasPendingSteeringInput: () => boolean;
  readonly isCurrent: () => boolean;
  readonly manualCompactionRequested: () => boolean;
  readonly modelFactory: AgentModelFactory;
  readonly now: () => number;
  readonly pendingComponent: (
    component: SessionRuntimePendingComponent,
  ) => void;
  readonly restartHandoffRequested: () => boolean;
  readonly notify: () => void;
  readonly realtime: RealtimeHub | undefined;
  readonly sessionTools: SessionAgentToolActions;
  readonly signal: AbortSignal;
  readonly store: SessionStore;
  readonly toolSettings: ToolSettings;
  readonly userId: string;
}

function markProviderPending(
  runtime: SessionAgentRuntimeDependencies,
  state: ProviderRequestState,
): void {
  runtime.pendingComponent(
    state === "admission" ? "provider_admission" : "provider_request",
  );
}

async function loadModels(
  runtime: SessionAgentRuntimeDependencies,
  options: {
    readonly streamId?: string;
    readonly toolStream?: ToolStreamPublisher;
  } = {},
): Promise<SessionAgentModels> {
  const settings = runtime.toolSettings;
  return withLoadingDeadline(
    runtime.signal,
    settings,
    async (signal) => {
      const agentFile = await executeForSession(runtime, () =>
        loadSessionAgentFile(
          runtime.broker,
          runtime.detail,
          signal,
          runtime.isCurrent,
        ),
      );
      writeRuntime(runtime, (sessionId, now, generation) => {
        runtime.store.setRuntimeAgentFile(
          sessionId,
          agentFile,
          now,
          generation,
        );
      });
      throwIfRestartRequested(runtime);
      const metadata = await sessionRequestMetadata(
        runtime,
        (apply) => {
          writeRuntime(runtime, apply);
        },
        signal,
      );
      throwIfRestartRequested(runtime);
      const onRequestState = (state: ProviderRequestState) => {
        markProviderPending(runtime, state);
      };
      return createSessionAgentModels({
        agentFile,
        credential: runtime.credential,
        detail: { ...runtime.detail, ...metadata },
        factory: runtime.modelFactory,
        isCurrent: runtime.isCurrent,
        onRequestState,
        onStepStart: () => {
          markSessionStepStart(runtime);
        },
        realtime: runtime.realtime,
        ...(options.streamId === undefined
          ? {}
          : { streamId: options.streamId }),
        ...(options.toolStream === undefined
          ? {}
          : { toolStream: options.toolStream }),
        toolSettings: settings,
        userId: runtime.userId,
      });
    },
    isRestartHandoffError,
  );
}

export async function compactSessionConversation(
  runtime: SessionAgentRuntimeDependencies,
  continueAfterCompaction = false,
): Promise<"complete" | "handoff"> {
  await Promise.resolve();
  if (runtime.restartHandoffRequested()) {
    return "handoff";
  }
  const models = await loadModels(runtime);
  if (runtime.restartHandoffRequested()) {
    return "handoff";
  }
  const conversation = sessionRuntimeConversation(runtime);
  const truncation = runtime.store.conversationTruncation(runtime.detail.id);
  const compactor = models.createCompactor();
  const startedAt = runtime.now();
  try {
    const final = await compactor.compact(
      truncation === undefined
        ? conversation
        : [
            ...conversation,
            { content: "", role: "compaction_notice", truncation } as const,
          ],
      runtime.signal,
    );
    throwIfAgentAborted(runtime.signal);
    const usage = compactionUsage(final, (step) =>
      estimateAgentStepCost(runtime.detail, step.tokenUsage),
    );
    recordCompaction(
      runtime,
      final.summary,
      usage,
      startedAt,
      !continueAfterCompaction,
    );
    return "complete";
  } finally {
    models.publishCompactionSettled();
  }
}

const RESTART_INTERRUPTED_TOOL_OUTPUT =
  "Error: the runner disconnected before this tool call returned; retry it after restart.";

function restartInterruptedToolResult(): RunnerCommandResult {
  return { output: RESTART_INTERRUPTED_TOOL_OUTPUT, state: "canceled" };
}

function boundRuntimeToolOutput(
  runtime: SessionAgentRuntimeDependencies,
  result: RunnerCommandResult,
  toolName?: string,
): RunnerCommandResult {
  return boundSessionToolOutput(result, runtime.toolSettings, toolName);
}

async function executeAgentTool(
  runtime: SessionAgentRuntimeDependencies,
  stepTools: ReadonlySet<AgentSessionToolName>,
  currentTools: () => ReadonlySet<AgentSessionToolName> | undefined,
  skills: ReturnType<typeof createAgentSkills>,
  dispatchTool: AgentToolDispatcher,
  toolSignal: AbortSignal,
  call: Parameters<typeof runCompactingAgentLoop>[0]["executeTool"] extends (
    input: infer Input,
  ) => Promise<RunnerCommandResult | string>
    ? Input
    : never,
): Promise<RunnerCommandResult> {
  if (
    isRestartHandoffError(toolSignal.reason) ||
    runtime.restartHandoffRequested()
  ) {
    return restartInterruptedToolResult();
  }
  const trackOuterCall =
    call.name === "brave_search" ||
    call.name === "parallel" ||
    (isAgentSessionToolName(call.name) && isSessionAgentToolName(call.name));
  const finishOuterTracking = trackOuterCall
    ? runtime.activeTools.begin(runtime.detail.id, call.id, call.name)
    : () => undefined;
  try {
    if (
      !isAgentSessionToolName(call.name) ||
      !stepTools.has(call.name) ||
      currentTools()?.has(call.name) !== true
    ) {
      return {
        output: `Error: ${call.name} is not enabled for this session.`,
        state: "failed",
      };
    }
    return await executeAuthorizedRuntimeTool({
      call,
      dispatch: dispatchTool,
      executeSkill: skills.executeResult,
      outerSignal: toolSignal,
      settings: runtime.toolSettings,
      runtime,
      stepTools,
    });
  } catch (error) {
    if (isAskQuestionsPause(error)) {
      throw error;
    }
    if (
      isRestartHandoffError(error) ||
      isRestartHandoffError(toolSignal.reason)
    ) {
      return restartInterruptedToolResult();
    }
    throw error;
  } finally {
    finishOuterTracking();
  }
}

export async function runSessionAgent(
  runtime: SessionAgentRuntimeDependencies,
): Promise<"complete" | "handoff"> {
  const settings = runtime.toolSettings;
  const streamId = createUuidV7();
  const initialMessages = sessionRuntimeConversation(runtime);
  const messages =
    runtime.continuous && initialMessages.at(-1)?.role === "assistant"
      ? [...initialMessages, { content: "Continue.", role: "user" as const }]
      : initialMessages;
  const toolStream = new ToolStreamPublisher({
    sessionId: runtime.detail.id,
    streamId,
    ...(runtime.realtime === undefined ? {} : { transport: runtime.realtime }),
    userId: runtime.userId,
    workspaceId: runtime.detail.workspaceId,
  });
  const models = await loadModels(runtime, { streamId, toolStream });
  const handoffController = new AbortController();
  const toolSignal = AbortSignal.any([
    runtime.signal,
    handoffController.signal,
  ]);
  const stepTools = new Set<AgentSessionToolName>(runtime.detail.tools);
  // Resumed runs park at their next step boundary too; exempting them let a
  // drain that caught one never converge.
  const stepBoundaryRequested = runtime.restartHandoffRequested;
  const currentToolNames = (): readonly AgentSessionToolName[] | undefined =>
    currentExecutionTools({
      current: runtime.currentTools?.(),
      isCurrent: runtime.isCurrent,
      persisted: runtime.detail.tools,
    });
  const currentTools = (): ReadonlySet<AgentSessionToolName> | undefined => {
    const tools = readAgentSessionToolNames(currentToolNames());
    return tools === undefined ? undefined : new Set(tools);
  };
  const trackTool = activeToolTracker(runtime.activeTools, runtime.detail.id);
  const dispatchRunnerTool = async (
    name: string,
    toolArguments: Readonly<Record<string, unknown>>,
    signal: AbortSignal = toolSignal,
    callId?: string,
  ): Promise<RunnerCommandResult> => {
    const result = await executeForSession(
      runtime,
      () =>
        runtime.broker.dispatch(
          {
            arguments: toolArguments,
            authorize: () =>
              currentToolNames()?.some((candidate) => candidate === name) ===
              true,
            executionEnvironment: runtime.detail.executionEnvironment,
            executionLimitSeconds: toolExecutionLimitSeconds(settings),
            generation: runtime.detail.generation,
            outputLimitCharacters: settings.outputLimitCharacters,
            runnerId: runtime.detail.runnerId,
            sessionId: runtime.detail.id,
            tool: name,
            workingDirectory: runtime.detail.workingDirectory,
          },
          signal,
          callId === undefined
            ? undefined
            : (delta: RunnerCommandOutputDelta) => {
                toolStream.output(callId, delta);
              },
        ),
      (error) => {
        handoffController.abort(error);
      },
    );
    if (name !== "explain_file" || result.state !== "completed") {
      return result;
    }
    const finishExplanationTracking = trackTool(
      callId ?? createUuidV7(),
      name,
      { runnerCommand: false },
    );
    try {
      const promptValue = toolArguments["prompt"];
      if (
        promptValue !== undefined &&
        (typeof promptValue !== "string" || promptValue.length > 4_000)
      ) {
        throw new Error(
          "Tool argument prompt must be a string of at most 4000 characters",
        );
      }
      let attachment: AgentAttachment | undefined;
      try {
        attachment = readAgentAttachments([JSON.parse(result.output)])?.[0];
      } catch {
        attachment = undefined;
      }
      if (attachment === undefined) {
        throw new Error("The runner returned invalid file attachment data");
      }
      throwIfRestartRequested(runtime);
      const currentModel = await discoverCurrentSessionModel(runtime, signal);
      // Discovery may ignore cancellation and settle after the wrapper already
      // reported timed-out; never start explanation model work afterward.
      throwIfAgentAborted(signal);
      throwIfRestartRequested(runtime);
      if (currentModel === undefined) {
        throw new Error(
          "The session model is unavailable for file explanation",
        );
      }
      const explanation = await explainAttachment(
        {
          attachment,
          currentCredential: runtime.credential,
          currentModel,
          currentModelId: runtime.detail.model,
          currentProvider: runtime.detail.provider,
          currentProviderPricing: runtime.detail.providerPricing,
          currentProviderTag: runtime.detail.openRouterProviderTag,
          factory: runtime.modelFactory,
          onStepStart: () => {
            markSessionStepStart(runtime);
          },
          prompt: typeof promptValue === "string" ? promptValue : null,
          resources: runtime,
          restartRequested: runtime.restartHandoffRequested,
          toolSettings: runtime.toolSettings,
          userId: runtime.userId,
          workspaceId: runtime.detail.workspaceId,
        },
        signal,
      );
      const usage = agentStepUsage(
        { contextTokens: null, ...explanation.usage },
        (step) =>
          estimateAgentStepCost(
            { providerPricing: explanation.providerPricing },
            step.tokenUsage,
          ),
      );
      if (usage !== undefined) {
        recordRuntimeUsage(runtime, usage);
      }
      return { output: explanation.content, state: "completed" };
    } finally {
      finishExplanationTracking();
    }
  };
  const dispatchTool: AgentToolDispatcher = (
    name,
    toolArguments,
    signal = toolSignal,
    callId,
  ) => {
    if (isAgentSessionToolName(name) && isSessionAgentToolName(name)) {
      if (callId !== undefined) {
        toolStream.running(callId, name, JSON.stringify(toolArguments));
      }
      if (name === "sleep") {
        return executeSessionSleepTool(
          toolArguments,
          signal,
          () => runtime.hasPendingSteeringInput(),
          (sleepSignal) =>
            waitForSessionSteeringInput(runtime.detail.id, sleepSignal),
          runtime.now,
          settings,
        ).then((output) => ({ output, state: "completed" }));
      }
      return executeSessionAgentTool(
        runtime.sessionTools,
        name,
        toolArguments,
        signal,
      );
    }
    return dispatchRunnerTool(name, toolArguments, signal, callId);
  };
  const skills = createAgentSkills({
    braveSearch: runtime.braveSearch,
    currentTools: currentToolNames,
    executeTool: dispatchTool,
    restartRequested: runtime.restartHandoffRequested,
    trackTool: (callId, name, runnerCommand) =>
      trackTool(callId ?? createUuidV7(), name, { runnerCommand }),
    tools: runtime.detail.tools,
    userId: runtime.userId,
    workspaceId: runtime.detail.workspaceId,
  });
  const recorder = new SessionRecorder(
    runtime.store,
    runtime.detail.id,
    runtime.now,
    runtime.notify,
    runtime.detail.generation,
    runtime.userId,
  );

  const takeSteeringMessages = () => {
    const messages = runtime.store.takeSteeringInputs(
      runtime.detail.id,
      runtime.now(),
    );
    if (messages.length > 0) {
      runtime.notify();
    }
    return messages;
  };
  const finalizeToolResult = (result: RunnerCommandResult, toolName: string) =>
    boundRuntimeToolOutput(runtime, result, toolName);
  try {
    return await runCompactingAgentLoop({
      agentCost: (step) =>
        estimateAgentStepCost(runtime.detail, step.tokenUsage),
      autoCompact: runtime.detail.autoCompact,
      maxContextTokens: runtime.detail.maxContextTokens,
      createCompactor: models.createCompactor,
      executeTool: (call) =>
        executeAgentTool(
          runtime,
          stepTools,
          currentTools,
          skills,
          dispatchTool,
          toolSignal,
          call,
        ),
      finalizeToolResult,
      ...(runtime.detail.restartHandoff?.operation === "agent"
        ? { initialContextTokens: runtime.detail.currentContextTokens }
        : {}),
      initialMessages: messages,
      handoffRequested: stepBoundaryRequested,
      model: models.agent,
      now: runtime.now,
      onToolResult: (call, outcome) => {
        if (outcome.error !== undefined) {
          toolStream.failed(call.id, outcome.error);
        } else {
          toolStream.finish(call.id, outcome.state ?? "completed");
        }
      },
      onStepBoundary: () =>
        runtime.manualCompactionRequested() ? "compact" : undefined,
      recordCompaction: (summary, usage, startedAt) => {
        recordCompaction(runtime, summary, usage, startedAt);
      },
      settleCompaction: models.publishCompactionSettled,
      recordMessage: (messages, usage, terminal) => {
        if (terminal && runtime.detail.restartHandoff === null) {
          recorder.terminal(messages, null, usage);
        } else {
          recorder.messages(messages, usage);
        }

        forEachAssistantToolCall(messages, (call) => {
          if (
            !isAgentSessionToolName(call.name) ||
            !isSessionAgentToolName(call.name)
          ) {
            toolStream.running(call.id, call.name, call.arguments);
          }
        });
      },
      signal: runtime.signal,
      takeSteeringMessages,
    });
  } catch (error) {
    toolStream.close(
      error instanceof DOMException && error.name === "AbortError"
        ? "canceled"
        : "failed",
    );
    throw error;
  } finally {
    models.agent.close?.();
    runtime.realtime?.clearToolStreams(runtime.userId, runtime.detail.id);
  }
}
