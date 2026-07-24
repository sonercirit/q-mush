import {
  isAgentSessionToolName,
  isSessionAgentToolName,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import { createUuidV7 } from "../shared/ids.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type {
  RunnerCommandBroker,
  RunnerCommandResult,
  RunnerToolOutputDelta,
} from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { estimateAgentTurnCost } from "./agent-cost.ts";
import { createAgentSkills } from "./agent-skills.ts";
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
import { SessionRecorder } from "./session-recorder.ts";
import type { SessionStore } from "./session-store.ts";
import { ToolStreamPublisher } from "./tool-stream-publisher.ts";

export interface SessionAgentRuntimeDependencies {
  readonly braveSearch: {
    execute(
      userId: string,
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<string>;
  };
  readonly broker: RunnerCommandBroker;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly modelFactory: AgentModelFactory;
  readonly now: () => number;
  readonly notify: () => void;
  readonly realtime: RealtimeHub | undefined;
  readonly sessionTools: SessionAgentToolActions;
  readonly signal: AbortSignal;
  readonly store: SessionStore;
  readonly userId: string;
}

async function loadModels(
  runtime: SessionAgentRuntimeDependencies,
  options: {
    readonly streamId?: string;
    readonly toolStream?: ToolStreamPublisher;
  } = {},
): Promise<SessionAgentModels> {
  const agentFile = await loadSessionAgentFile(
    runtime.broker,
    runtime.detail,
    runtime.signal,
  );
  runtime.store.setAgentFile(runtime.detail.id, agentFile, runtime.now());
  runtime.notify();
  return createSessionAgentModels({
    agentFile,
    credential: runtime.credential,
    detail: runtime.detail,
    factory: runtime.modelFactory,
    realtime: runtime.realtime,
    ...(options.streamId === undefined ? {} : { streamId: options.streamId }),
    ...(options.toolStream === undefined
      ? {}
      : { toolStream: options.toolStream }),
    userId: runtime.userId,
  });
}

export async function compactSessionConversation(
  runtime: SessionAgentRuntimeDependencies,
): Promise<void> {
  await Promise.resolve();
  const models = await loadModels(runtime);
  const conversation = runtime.store.conversation(runtime.detail.id);
  const compactor = models.createCompactor();
  const compacted = await compactor.compact(conversation, runtime.signal);
  const costUsd =
    compacted.costUsd ??
    estimateAgentTurnCost(runtime.detail, compacted.tokenUsage);
  const costBasis =
    costUsd === null
      ? null
      : compacted.costUsd === null
        ? "estimated"
        : "reported";
  if (costBasis !== null) {
    runtime.store.updateUsage(
      runtime.detail.id,
      { contextTokens: null, costBasis, costUsd },
      runtime.now(),
    );
    runtime.notify();
  }
  runtime.store.compact(runtime.detail.id, compacted.summary, runtime.now());
}

export async function runSessionAgent(
  runtime: SessionAgentRuntimeDependencies,
): Promise<void> {
  const toolStream = new ToolStreamPublisher({
    hub: runtime.realtime,
    sessionId: runtime.detail.id,
    streamId: createUuidV7(),
    userId: runtime.userId,
  });
  const models = await loadModels(runtime, { toolStream });
  const dispatchRunnerTool = async (
    input: Readonly<{
      callId: string | undefined;
      name: string;
      signal: AbortSignal | undefined;
      toolArguments: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<RunnerCommandResult> => {
    const liveCallId = input.callId;
    const stream =
      liveCallId === undefined
        ? undefined
        : ({ channel, content }: RunnerToolOutputDelta) => {
            toolStream.output(liveCallId, channel, content);
          };
    return runtime.broker.dispatch(
      {
        arguments: input.toolArguments,
        runnerId: runtime.detail.runnerId,
        sessionId: runtime.detail.id,
        tool: input.name,
        workingDirectory: runtime.detail.workingDirectory,
      },
      input.signal ?? runtime.signal,
      stream,
    );
  };
  const dispatchTool = async (
    name: string,
    toolArguments: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    callId?: string,
  ): Promise<RunnerCommandResult> => {
    const sessionTool =
      isAgentSessionToolName(name) && isSessionAgentToolName(name);
    if (sessionTool) {
      return executeSessionAgentTool(runtime.sessionTools, name, toolArguments);
    }
    return dispatchRunnerTool({ callId, name, signal, toolArguments });
  };
  const skills = createAgentSkills({
    braveSearch: runtime.braveSearch,
    executeTool: dispatchTool,
    tools: runtime.detail.tools,
    userId: runtime.userId,
  });
  const recorder = new SessionRecorder(
    runtime.store,
    runtime.detail.id,
    runtime.now,
    runtime.notify,
  );

  const selectedTools = new Set<AgentSessionToolName>(runtime.detail.tools);
  try {
    await runCompactingAgentLoop({
      agentCost: (turn) =>
        estimateAgentTurnCost(runtime.detail, turn.tokenUsage),
      autoCompact: runtime.detail.autoCompact,
      createCompactor: models.createCompactor,
      executeTool: (call) => {
        if (
          !isAgentSessionToolName(call.name) ||
          !selectedTools.has(call.name)
        ) {
          return Promise.resolve({
            output: `Error: ${call.name} is not enabled for this session.`,
            state: "failed",
          });
        }
        const skillOutput = skills.execute(
          call.name,
          call.arguments,
          runtime.signal,
          call.id,
        );
        if (skillOutput !== undefined) {
          return skillOutput;
        }
        return dispatchTool(call.name, call.arguments, undefined, call.id);
      },
      initialMessages: runtime.store.conversation(runtime.detail.id),
      maxContextTokens: runtime.detail.maxContextTokens,
      model: models.agent,
      onToolResult: (call, outcome) => {
        if (outcome.error !== undefined) {
          toolStream.failed(call.id, outcome.error);
        } else {
          toolStream.finish(call.id, outcome.state ?? "completed");
        }
      },
      recordCompaction: (summary) => {
        runtime.store.compact(runtime.detail.id, summary, runtime.now());
        runtime.notify();
      },
      recordMessage: (message) => {
        recorder.message(message);
        if (message.role === "assistant") {
          for (const call of message.toolCalls) {
            toolStream.running(call.id, call.name);
          }
        }
      },
      recordUsage: (usage) => {
        recorder.usage(usage);
      },
      signal: runtime.signal,
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
