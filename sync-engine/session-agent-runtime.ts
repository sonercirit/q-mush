import {
  isAgentSessionToolName,
  isSessionAgentToolName,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";
import { estimateAgentTurnCost } from "./agent-cost.ts";
import { createAgentSkills } from "./agent-skills.ts";
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
import { SessionRecorder } from "./session-recorder.ts";
import type { SessionStore } from "./session-store.ts";

export interface SessionAgentRuntimeDependencies {
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly broker: RunnerCommandBroker;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly modelFactory: AgentModelFactory;
  readonly isCurrent: () => boolean;
  readonly now: () => number;
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
): void {
  writeRuntime(runtime, (sessionId, now, generation) => {
    runtime.store.compact(sessionId, summary, now, generation);
  });
}

async function loadModels(
  runtime: SessionAgentRuntimeDependencies,
): Promise<SessionAgentModels> {
  const agentFile = await loadSessionAgentFile(
    runtime.broker,
    runtime.detail,
    runtime.signal,
  );
  writeRuntime(runtime, (sessionId, now, generation) => {
    runtime.store.setAgentFile(sessionId, agentFile, now, generation);
  });
  return createSessionAgentModels({
    agentFile,
    credential: runtime.credential,
    detail: runtime.detail,
    factory: runtime.modelFactory,
    isCurrent: runtime.isCurrent,
    realtime: runtime.realtime,
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
    const usage: AgentSessionUsageUpdate = {
      contextTokens: null,
      costBasis,
      costUsd,
    };
    writeRuntime(runtime, (sessionId, now, generation) => {
      runtime.store.updateUsage(sessionId, usage, now, generation);
    });
  }
  recordCompaction(runtime, compacted.summary);
}

export async function runSessionAgent(
  runtime: SessionAgentRuntimeDependencies,
): Promise<void> {
  const models = await loadModels(runtime);
  const dispatchRunnerTool = (
    name: string,
    toolArguments: Readonly<Record<string, unknown>>,
    signal: AbortSignal = runtime.signal,
  ): Promise<string> =>
    runtime.broker.dispatch(
      {
        arguments: toolArguments,
        authorize: runtime.isCurrent,
        runnerId: runtime.detail.runnerId,
        sessionId: runtime.detail.id,
        tool: name,
        workingDirectory: runtime.detail.workingDirectory,
      },
      signal,
    );
  const dispatchTool = (
    name: string,
    toolArguments: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<string> =>
    isAgentSessionToolName(name) && isSessionAgentToolName(name)
      ? executeSessionAgentTool(runtime.sessionTools, name, toolArguments)
      : dispatchRunnerTool(name, toolArguments, signal);
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
    runtime.detail.generation,
  );

  const selectedTools = new Set<AgentSessionToolName>(runtime.detail.tools);
  await runCompactingAgentLoop({
    agentCost: (turn) => estimateAgentTurnCost(runtime.detail, turn.tokenUsage),
    autoCompact: runtime.detail.autoCompact,
    createCompactor: models.createCompactor,
    executeTool: (call) => {
      if (!isAgentSessionToolName(call.name) || !selectedTools.has(call.name)) {
        return Promise.resolve(
          `Error: ${call.name} is not enabled for this session.`,
        );
      }
      const skillOutput = skills.execute(
        call.name,
        call.arguments,
        runtime.signal,
      );
      if (skillOutput !== undefined) {
        return skillOutput;
      }
      return dispatchTool(call.name, call.arguments);
    },
    initialMessages: runtime.store.conversation(runtime.detail.id),
    maxContextTokens: runtime.detail.maxContextTokens,
    model: models.agent,
    recordCompaction: (summary) => {
      recordCompaction(runtime, summary);
    },
    recordMessage: (message) => {
      recorder.message(message);
    },
    recordUsage: (usage) => {
      recorder.usage(usage);
    },
    signal: runtime.signal,
  });
}
