import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { RunnerIntegration } from "./runners.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "./session-agent-runtime.ts";
import {
  finishSession,
  type SessionFinishDependencies,
} from "./session-finish.ts";
import { sessionModelRuntime } from "./session-model-runtime.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

export interface SessionExecutionDependencies {
  readonly actions: SessionAgentActions;
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly broker: RunnerCommandBroker;
  readonly modelFactory: AgentModelFactory;
  readonly notify: SessionFinishDependencies["notify"];
  readonly now: () => number;
  readonly realtime: RealtimeHub | undefined;
  readonly runners: RunnerIntegration;
  readonly runtimes: SessionRuntimes;
  readonly store: SessionStore;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function finishDependencies(
  dependencies: SessionExecutionDependencies,
  credential: ProviderCredentialAccess,
  userId: string,
  controller: AbortController,
): SessionFinishDependencies {
  return {
    actionsFinished: (finished, ownerId) => {
      dependencies.actions.finished(finished, ownerId);
    },
    notify: dependencies.notify,
    now: dependencies.now,
    rerun: (current) =>
      runStoredSession(
        dependencies,
        current,
        credential,
        userId,
        controller,
        false,
        current.status === "running" ? "running_continuation" : "queued",
      ),
    runners: dependencies.runners,
    runtimes: dependencies.runtimes,
    store: dependencies.store,
  };
}

// cpd-ignore-start -- The extracted runner delegates the same runtime signature as its integration owner.
export async function runStoredSession(
  dependencies: SessionExecutionDependencies,
  detail: AgentSessionDetail,
  credential: ProviderCredentialAccess,
  userId: string,
  controller: AbortController,
  compact: boolean,
  start: "queued" | "running_continuation" = "queued",
): Promise<void> {
  const started =
    start === "queued"
      ? dependencies.store.mark(detail.id, "running", dependencies.now())
      : !controller.signal.aborted &&
        dependencies.store.get(userId, detail.id)?.status === "running";
  if (!started) {
    return;
  }
  dependencies.notify(userId, detail.id);

  const finish = (error?: unknown) =>
    finishSession(
      finishDependencies(dependencies, credential, userId, controller),
      detail,
      userId,
      error,
    );
  try {
    const runtime = sessionModelRuntime(
      {
        actions: dependencies.actions,
        braveSearch: dependencies.braveSearch,
        broker: dependencies.broker,
        modelFactory: dependencies.modelFactory,
        now: dependencies.now,
        notify: dependencies.notify,
        realtime: dependencies.realtime,
        store: dependencies.store,
      },
      detail,
      credential,
      userId,
      controller,
    );
    await (compact
      ? compactSessionConversation(runtime)
      : runSessionAgent(runtime));
    await finish();
  } catch (error) {
    if (!controller.signal.aborted && !isAbort(error)) {
      await finish(error);
    }
  }
}
// cpd-ignore-end
