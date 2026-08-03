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
  RunnerDisconnectedError,
  type RunnerCommandBroker,
  type RunnerCommandOutputDelta,
  type RunnerCommandResult,
} from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import { forEachAssistantToolCall } from "./agent-conversation.ts";
import { estimateAgentStepCost } from "./agent-cost.ts";
import { createAgentSkills, type AgentSkillExecutor } from "./agent-skills.ts";
import {
  isAskQuestionsPause,
  isAskQuestionsToolName,
  pauseForAskQuestions,
} from "./ask-questions-pause.ts";
import { explainAttachment } from "./attachment-fallback-model.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import { loadSessionAgentFile } from "./session-agent-file.ts";
import { runCompactingAgentLoop } from "./session-agent-loop.ts";
import {
  createSessionAgentModels,
  type AgentModelFactory,
  type SessionAgentModels,
} from "./session-agent-models.ts";
import { currentExecutionTools } from "./session-agent-tool-authority.ts";
import {
  executeSessionAgentTool,
  type SessionAgentToolActions,
} from "./session-agent-tools.ts";
import {
  agentStepUsage,
  compactionUsage,
  type CompactionUsage,
} from "./session-compaction-usage.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";
import { SessionRecorder } from "./session-recorder.ts";
import { executeSessionSleepTool } from "./session-sleep-tool.ts";
import { waitForSessionSteeringInput } from "./session-steering-wakeup.ts";
import type { SessionStore } from "./session-store.ts";
import { boundSessionToolOutput } from "./session-tool-output.ts";
import { ToolStreamPublisher } from "./tool-stream-publisher.ts";

export interface SessionAgentRuntimeDependencies extends AttachmentFallbackRuntimeResources {
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
  readonly restartHandoffRequested: () => boolean;
  readonly notify: () => void;
  readonly realtime: RealtimeHub | undefined;
  readonly sessionTools: SessionAgentToolActions;
  readonly signal: AbortSignal;
  readonly store: SessionStore;
  readonly userId: string;
}

function writeRuntime(
  runtime: SessionAgentRuntimeDependencies,
  write: (sessionId: string, now: number, generation: number) => void,
): void {
  write(runtime.detail.id, runtime.now(), runtime.detail.generation);
  runtime.notify();
}

function recordRuntimeUsage(
  runtime: SessionAgentRuntimeDependencies,
  usage: AgentSessionUsageUpdate,
): void {
  writeRuntime(runtime, (sessionId, now, generation) => {
    runtime.store.updateRuntimeUsage(sessionId, usage, now, generation);
  });
}

function recordCompactionContext(
  runtime: SessionAgentRuntimeDependencies,
  contextTokens: number | null,
): void {
  if (contextTokens !== null) {
    recordRuntimeUsage(runtime, {
      contextTokens,
      costBasis: null,
      costUsd: null,
    });
  }
}

function recordCompaction(
  runtime: SessionAgentRuntimeDependencies,
  summary: string,
  usage: CompactionUsage,
  startedAt: number,
  terminal = false,
): void {
  recordCompactionContext(runtime, usage.contextTokens);
  writeRuntime(runtime, (sessionId, now, generation) => {
    if (terminal) {
      runtime.store.compactRuntimeTerminal(
        sessionId,
        summary,
        usage,
        now,
        generation,
        startedAt,
        runtime.detail.restartHandoff,
      );
      return;
    }
    runtime.store.compactRuntimeConversation(
      sessionId,
      summary,
      usage,
      now,
      generation,
      startedAt,
    );
  });
}

function isSessionRestartHandoff(
  runtime: SessionAgentRuntimeDependencies,
  error: unknown,
): boolean {
  return (
    error instanceof RunnerDisconnectedError &&
    runtime.restartHandoffRequested()
  );
}

function restartHandoffError(): DOMException {
  return new DOMException(
    "The runner disconnected during a restart handoff",
    "RestartHandoff",
  );
}

async function executeForSession<Result>(
  runtime: SessionAgentRuntimeDependencies,
  execute: () => Promise<Result>,
  handoff?: (error: DOMException) => void,
): Promise<Result> {
  try {
    return await execute();
  } catch (error) {
    if (isSessionRestartHandoff(runtime, error)) {
      const handoffError = restartHandoffError();
      handoff?.(handoffError);
      throw handoffError;
    }
    throw error;
  }
}

export function isRestartHandoffError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "RestartHandoff";
}

function sessionConversation(
  runtime: SessionAgentRuntimeDependencies,
): ReturnType<SessionStore["conversation"]> {
  return runtime.store.conversation(
    runtime.detail.id,
    runtime.detail.restartHandoff === null,
  );
}

async function loadModels(
  runtime: SessionAgentRuntimeDependencies,
  options: {
    readonly streamId?: string;
    readonly toolStream?: ToolStreamPublisher;
  } = {},
): Promise<SessionAgentModels> {
  const agentFile = await executeForSession(runtime, () =>
    loadSessionAgentFile(
      runtime.broker,
      runtime.detail,
      runtime.signal,
      runtime.isCurrent,
    ),
  );
  writeRuntime(runtime, (sessionId, now, generation) => {
    runtime.store.setRuntimeAgentFile(sessionId, agentFile, now, generation);
  });
  const models = createSessionAgentModels({
    agentFile,
    credential: runtime.credential,
    detail: runtime.detail,
    factory: runtime.modelFactory,
    isCurrent: runtime.isCurrent,
    realtime: runtime.realtime,
    ...(options.streamId === undefined ? {} : { streamId: options.streamId }),
    ...(options.toolStream === undefined
      ? {}
      : { toolStream: options.toolStream }),
    userId: runtime.userId,
  });
  return models;
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
  const conversation = sessionConversation(runtime);
  const compactor = models.createCompactor();
  const startedAt = runtime.now();
  const estimateCost = (
    step: Pick<Parameters<typeof compactionUsage>[0], "costUsd" | "tokenUsage">,
  ) => estimateAgentStepCost(runtime.detail, step.tokenUsage);
  const final = await compactor.compact(conversation, runtime.signal);
  throwIfAgentAborted(runtime.signal);
  const usage = compactionUsage(final, estimateCost);
  try {
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

type AgentToolDispatcher = (
  ...parameters: Parameters<AgentSkillExecutor>
) => Promise<RunnerCommandResult>;

function restartInterruptedToolResult(): RunnerCommandResult {
  return { output: RESTART_INTERRUPTED_TOOL_OUTPUT, state: "canceled" };
}

function boundRuntimeToolOutput(
  runtime: SessionAgentRuntimeDependencies,
  signal: AbortSignal,
  result: RunnerCommandResult,
): Promise<RunnerCommandResult> {
  return boundSessionToolOutput(
    {
      broker: runtime.broker,
      detail: runtime.detail,
      isCurrent: runtime.isCurrent,
      signal,
    },
    result,
  );
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
  if (isRestartHandoffError(toolSignal.reason)) {
    return restartInterruptedToolResult();
  }
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
    if (isAskQuestionsToolName(call.name)) {
      return {
        output: pauseForAskQuestions(
          {
            notify: (userId, sessionId) => {
              if (
                userId === runtime.userId &&
                sessionId === runtime.detail.id
              ) {
                runtime.notify();
              }
            },
            now: runtime.now,
            questions: runtime.store.questions(),
          },
          {
            arguments: call.arguments,
            executionGeneration: runtime.detail.generation,
            selected: stepTools.has("ask_questions"),
            sessionId: runtime.detail.id,
            source: "direct",
            toolCallId: call.id,
            userId: runtime.userId,
          },
        ),
        state: "completed",
      };
    }
    const skillOutput = skills.executeResult(
      call.name,
      call.arguments,
      toolSignal,
      call.id,
    );
    const result = await (skillOutput ??
      dispatchTool(call.name, call.arguments, toolSignal, call.id));
    return skillOutput === undefined
      ? result
      : await boundRuntimeToolOutput(runtime, toolSignal, result);
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
  }
}

export async function runSessionAgent(
  runtime: SessionAgentRuntimeDependencies,
): Promise<"complete" | "handoff"> {
  const streamId = createUuidV7();
  const initialMessages = sessionConversation(runtime);
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
  const stepBoundaryRequested = (): boolean =>
    runtime.detail.restartHandoff === null && runtime.restartHandoffRequested();
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
            generation: runtime.detail.generation,
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
    const catalog = await runtime.discoverModels?.(
      runtime.detail.provider,
      runtime.credential,
    );
    const currentModel = catalog?.models.find(
      ({ id }) => id === runtime.detail.model,
    );
    if (currentModel === undefined) {
      throw new Error("The session model is unavailable for file explanation");
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
        prompt: typeof promptValue === "string" ? promptValue : null,
        resources: runtime,
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
        ).then((output) => ({ output, state: "completed" }));
      }
      return executeSessionAgentTool(
        runtime.sessionTools,
        name,
        toolArguments,
      ).then((result) => boundRuntimeToolOutput(runtime, signal, result));
    }
    return dispatchRunnerTool(name, toolArguments, signal, callId);
  };
  const skills = createAgentSkills({
    braveSearch: runtime.braveSearch,
    currentTools: currentToolNames,
    executeTool: dispatchTool,
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
        try {
          recordCompaction(runtime, summary, usage, startedAt);
        } finally {
          models.publishCompactionSettled();
        }
      },
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
    runtime.realtime?.clearToolStreams(runtime.userId, runtime.detail.id);
  }
}
