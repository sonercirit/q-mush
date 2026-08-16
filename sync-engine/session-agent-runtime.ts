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
  type RunnerCommandResult,
} from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { forEachAssistantToolCall } from "./agent-conversation.ts";
import { estimateAgentStepCost } from "./agent-cost.ts";
import { createAgentSkills } from "./agent-skills.ts";
import {
  isAskQuestionsPause,
  isAskQuestionsToolName,
  pauseForAskQuestions,
} from "./ask-questions-pause.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import { loadSessionAgentFile } from "./session-agent-file.ts";
import { runCompactingAgentLoop } from "./session-agent-loop.ts";
import {
  createSessionAgentModels,
  type AgentModelFactory,
  type SessionAgentModels,
} from "./session-agent-models.ts";
import {
  executeSessionAgentTool,
  type SessionAgentToolActions,
} from "./session-agent-tools.ts";
import {
  compactionUsage,
  type CompactionUsage,
} from "./session-compaction-usage.ts";
import { readSessionConversation } from "./session-conversation.ts";
import { sessionRequestMetadata } from "./session-current-model.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";
import { SessionRecorder } from "./session-recorder.ts";
import {
  createRunnerToolDispatcher,
  type AgentToolDispatcher,
} from "./session-runner-tool-dispatcher.ts";
import {
  recordSessionRuntimeUsage,
  writeSessionRuntime,
  type SessionRuntimeWriter,
} from "./session-runtime-write.ts";
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

function markSessionStepStart(runtime: SessionAgentRuntimeDependencies): void {
  // Status- and generation-guarded: a racing stop or restart makes this
  // write match zero rows instead of throwing.
  const { store } = runtime;
  writeSessionRuntime(runtime, store.markRuntimeStepStart.bind(store));
}

function recordCompactionContext(
  runtime: SessionAgentRuntimeDependencies,
  contextTokens: number | null,
): void {
  if (contextTokens !== null) {
    recordSessionRuntimeUsage(runtime, {
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
  writeSessionRuntime(runtime, (sessionId, now, generation) => {
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
  writeSessionRuntime(runtime, (sessionId, now, generation) => {
    runtime.store.setRuntimeAgentFile(sessionId, agentFile, now, generation);
  });
  const metadata = await sessionRequestMetadata(
    runtime,
    (apply) => {
      writeSessionRuntime(runtime, apply);
    },
    runtime.signal,
  );
  const models = createSessionAgentModels({
    agentFile,
    credential: runtime.credential,
    detail: { ...runtime.detail, ...metadata },
    factory: runtime.modelFactory,
    isCurrent: runtime.isCurrent,
    onStepStart: () => {
      markSessionStepStart(runtime);
    },
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
  const conversation = readSessionConversation(runtime);
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
  const initialMessages = readSessionConversation(runtime);
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
  const { currentToolNames, dispatchRunnerTool } = createRunnerToolDispatcher({
    executeForSession: (execute, handoff) =>
      executeForSession(runtime, execute, handoff),
    handoffController,
    runtime,
    toolSignal,
    toolStream,
    writeRuntime: ((write) => {
      writeSessionRuntime(runtime, write);
    }) satisfies SessionRuntimeWriter,
  });
  const currentTools = (): ReadonlySet<AgentSessionToolName> | undefined => {
    const tools = readAgentSessionToolNames(currentToolNames());
    return tools === undefined ? undefined : new Set(tools);
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
