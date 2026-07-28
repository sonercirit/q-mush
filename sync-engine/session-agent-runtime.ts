import { throwIfAgentAborted, type AgentModel } from "../shared/agent-loop.ts";
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
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { forEachAssistantToolCall } from "./agent-conversation.ts";
import { estimateAgentTurnCost } from "./agent-cost.ts";
import { createAgentSkills, type AgentSkillExecutor } from "./agent-skills.ts";
import {
  isAskQuestionsPause,
  isAskQuestionsToolName,
  pauseForAskQuestions,
} from "./ask-questions-pause.ts";
import { AttachmentFallbackAgentModel } from "./attachment-fallback-model.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import { loadSessionAgentFile } from "./session-agent-file.ts";
import { runCompactingAgentLoop } from "./session-agent-loop.ts";
import {
  createFallbackModel,
  createSessionAgentModels,
  type AgentModelFactory,
  type SessionAgentModels,
} from "./session-agent-models.ts";
import {
  executeSessionAgentTool,
  type SessionAgentToolActions,
} from "./session-agent-tools.ts";
import { storeSessionAttachment } from "./session-attachment-store.ts";
import {
  compactionUsage,
  type CompactionUsage,
} from "./session-compaction-usage.ts";
import type { AttachmentFallbackRuntimeResources } from "./session-model-resources.ts";
import { SessionRecorder } from "./session-recorder.ts";
import { executeSessionSleepTool } from "./session-sleep-tool.ts";
import { waitForSessionSteeringInput } from "./session-steering-wakeup.ts";
import type { SessionStore } from "./session-store.ts";
import { ToolStreamPublisher } from "./tool-stream-publisher.ts";

export interface SessionAgentRuntimeDependencies extends AttachmentFallbackRuntimeResources {
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly broker: RunnerCommandBroker;
  readonly credential: ProviderCredentialAccess;
  readonly currentTools?: () => readonly AgentSessionToolName[] | undefined;
  readonly detail: AgentSessionDetail;
  readonly hasPendingSteeringInput: () => boolean;
  readonly isCurrent: () => boolean;
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

function recordCompaction(
  runtime: SessionAgentRuntimeDependencies,
  summary: string,
  usage: CompactionUsage,
  terminal = false,
): void {
  writeRuntime(runtime, (sessionId, now, generation) => {
    if (terminal) {
      runtime.store.compactRuntimeTerminal(
        sessionId,
        summary,
        usage,
        now,
        generation,
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

async function fallbackAgentModel(
  runtime: SessionAgentRuntimeDependencies,
  model: AgentModel,
): Promise<AgentModel> {
  const selections = runtime.attachmentFallbacks?.() ?? [];
  if (
    selections.length === 0 ||
    runtime.discoverModels === undefined ||
    runtime.readCredential === undefined
  ) {
    return model;
  }
  const discoverModels = runtime.discoverModels;
  const readCredential = runtime.readCredential;
  const currentCatalog = await discoverModels(
    runtime.detail.provider,
    runtime.credential,
  );
  const currentModel = currentCatalog.models.find(
    ({ id }) => id === runtime.detail.model,
  );
  if (currentModel === undefined) return model;
  return new AttachmentFallbackAgentModel({
    convert: async ({ attachment, selection }, signal) => {
      const credential = await readCredential(runtime.userId, {
        ...selection,
        workspaceId: runtime.detail.workspaceId,
      });
      if (credential === undefined) {
        throw new Error(
          `The ${selection.modality} fallback credential is unavailable`,
        );
      }
      const catalog = await discoverModels(selection.provider, credential);
      const selectedModel = catalog.models.find(
        ({ id }) => id === selection.model,
      );
      if (selectedModel === undefined) {
        throw new Error(
          `The ${selection.modality} fallback model is unavailable`,
        );
      }
      const fallback = createFallbackModel(runtime.modelFactory, {
        credential,
        model: selection.model,
        prompt: selection.prompt ?? selectedModel.fallbackPrompt ?? null,
        provider: selection.provider,
      });
      const turn = await fallback.complete(
        [{ attachments: [attachment], content: "", role: "user" }],
        signal,
      );
      const reference = await storeSessionAttachment({
        attachment,
        broker: runtime.broker,
        description: turn.content,
        session: runtime.detail,
        signal: signal ?? runtime.signal,
      });
      return { reference, text: turn.content };
    },
    currentModel,
    model,
    selections,
  });
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
  return {
    ...models,
    agent: await fallbackAgentModel(runtime, models.agent),
  };
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
  const estimateCost = (turn: Parameters<typeof compactionUsage>[0]) =>
    estimateAgentTurnCost(runtime.detail, turn.tokenUsage);
  const final = await compactor.compact(conversation, runtime.signal);
  throwIfAgentAborted(runtime.signal);
  const usage = compactionUsage(final, estimateCost);
  recordCompaction(runtime, final.summary, usage, !continueAfterCompaction);
  return "complete";
}

const RESTART_INTERRUPTED_TOOL_OUTPUT =
  "Error: the runner disconnected before this tool call returned; retry it after restart.";

type AgentToolDispatcher = (
  ...parameters: Parameters<AgentSkillExecutor>
) => Promise<RunnerCommandResult>;

function restartInterruptedToolResult(): RunnerCommandResult {
  return { output: RESTART_INTERRUPTED_TOOL_OUTPUT, state: "canceled" };
}

async function executeAgentTool(
  runtime: SessionAgentRuntimeDependencies,
  turnTools: ReadonlySet<AgentSessionToolName>,
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
      !turnTools.has(call.name) ||
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
            selected: turnTools.has("ask_questions"),
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
    return await (skillOutput ??
      dispatchTool(call.name, call.arguments, toolSignal, call.id));
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
  const dispatchRunnerTool = (
    name: string,
    toolArguments: Readonly<Record<string, unknown>>,
    signal: AbortSignal = toolSignal,
    callId?: string,
  ): Promise<RunnerCommandResult> =>
    executeForSession(
      runtime,
      () =>
        runtime.broker.dispatch(
          {
            arguments: toolArguments,
            authorize: () => {
              const current = runtime.currentTools?.();
              return (
                runtime.isCurrent() &&
                (current === undefined ||
                  current.some((candidate) => candidate === name))
              );
            },
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
      return executeSessionAgentTool(runtime.sessionTools, name, toolArguments);
    }
    return dispatchRunnerTool(name, toolArguments, signal, callId);
  };
  const skills = createAgentSkills({
    braveSearch: runtime.braveSearch,
    currentTools: runtime.currentTools,
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

  const turnTools = new Set<AgentSessionToolName>(runtime.detail.tools);
  const currentTools = (): ReadonlySet<AgentSessionToolName> | undefined => {
    const names =
      runtime.currentTools?.() ??
      (runtime.isCurrent() ? runtime.detail.tools : undefined);
    const tools = readAgentSessionToolNames(names);
    return tools === undefined ? undefined : new Set(tools);
  };
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
      agentCost: (turn) =>
        estimateAgentTurnCost(runtime.detail, turn.tokenUsage),
      autoCompact: runtime.detail.autoCompact,
      createCompactor: models.createCompactor,
      executeTool: (call) =>
        executeAgentTool(
          runtime,
          turnTools,
          currentTools,
          skills,
          dispatchTool,
          toolSignal,
          call,
        ),
      ...(runtime.detail.restartHandoff?.operation === "agent"
        ? { initialContextTokens: runtime.detail.currentContextTokens }
        : {}),
      initialMessages: sessionConversation(runtime),
      handoffRequested: runtime.restartHandoffRequested,
      maxContextTokens: runtime.detail.maxContextTokens,
      model: models.agent,
      onToolResult: (call, outcome) => {
        if (outcome.error !== undefined) {
          toolStream.failed(call.id, outcome.error);
        } else {
          toolStream.finish(call.id, outcome.state ?? "completed");
        }
      },
      recordCompaction: (summary, usage) => {
        recordCompaction(runtime, summary, usage);
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
