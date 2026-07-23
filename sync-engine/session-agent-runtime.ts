import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
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
import { SessionRecorder } from "./session-recorder.ts";
import type { SessionStore } from "./session-store.ts";

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
  readonly signal: AbortSignal;
  readonly store: SessionStore;
  readonly userId: string;
}

async function loadModels(
  runtime: SessionAgentRuntimeDependencies,
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
  const models = await loadModels(runtime);
  const skills = createAgentSkills({
    braveSearch: runtime.braveSearch,
    userId: runtime.userId,
  });
  const recorder = new SessionRecorder(
    runtime.store,
    runtime.detail.id,
    runtime.now,
    runtime.notify,
  );

  await runCompactingAgentLoop({
    agentCost: (turn) => estimateAgentTurnCost(runtime.detail, turn.tokenUsage),
    autoCompact: runtime.detail.autoCompact,
    createCompactor: models.createCompactor,
    executeTool: (call) => {
      const skillOutput = skills.execute(call.name, call.arguments);
      return (
        skillOutput ??
        runtime.broker.dispatch(
          {
            arguments: call.arguments,
            runnerId: runtime.detail.runnerId,
            sessionId: runtime.detail.id,
            tool: call.name,
            workingDirectory: runtime.detail.workingDirectory,
          },
          runtime.signal,
        )
      );
    },
    initialMessages: runtime.store.conversation(runtime.detail.id),
    maxContextTokens: runtime.detail.maxContextTokens,
    model: models.agent,
    recordCompaction: (summary) => {
      runtime.store.compact(runtime.detail.id, summary, runtime.now());
      runtime.notify();
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
