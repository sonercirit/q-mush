import { RESTART_DRAIN_LIMIT_MS } from "../shared/development-shutdown.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import { restartProgressReport } from "../shared/restart-progress.ts";
import type { RestartCredentialSelection } from "./session-restart-recovery.ts";
import {
  clearRestartTimer,
  setRestartTimer,
  type RestartSetTimeout,
  type RestartTimer,
} from "./session-restart-timers.ts";
import {
  isValidRestartId,
  type RestartDrainProgress,
  type RestartDrainSettlement,
  type RestartRequest,
  type RestartScope,
} from "./session-runtime.ts";

export interface RestartRuntimeControl {
  readonly accepts: (runnerId: string) => boolean;
  readonly blockRunner: (runnerId: string) => void;
  readonly drain: (scope: RestartScope, restartId: string) => Promise<unknown>;
  readonly drainProgress: (
    scope?: RestartScope,
  ) => readonly RestartDrainProgress[];
  readonly forcePark: (scope: RestartScope) => Promise<readonly string[]>;
  readonly mark: (scope: RestartScope, restartId: string) => Promise<unknown>;
  readonly requestDrain: (
    scope: RestartScope,
    restartId: string,
    durable: boolean,
  ) => Promise<RestartDrainSettlement>;
  readonly drainRequest: (scope: RestartScope) => RestartRequest | undefined;
  readonly draining: boolean;
  readonly resumeRunner: (runnerId: string, restartId: string) => boolean;
  readonly restoreRunner: (runnerId: string, restartId: string) => boolean;
  readonly start: (runnerId?: string) => void;
}

interface RestartDrainOptions {
  readonly clearTimeout: (id: RestartTimer) => void;
  readonly pendingTools: (sessionId: string) => readonly string[];
  readonly setTimeout: RestartSetTimeout;
  readonly warn: (message: string) => void;
}

export interface RestartDrainSessionProgress extends RestartDrainProgress {
  readonly tools: readonly string[];
}

export interface SessionRestartControl extends Pick<
  RestartRuntimeControl,
  "accepts" | "blockRunner" | "restoreRunner"
> {
  readonly cancelBoundedRunnerDrains: () => void;
  readonly drainProgress: (
    scope?: RestartScope,
  ) => readonly RestartDrainSessionProgress[];
  readonly draining: () => boolean;
  readonly drainServer: () => Promise<void>;
  readonly drainServerFinal: () => Promise<void>;
  readonly drainRunner: (runnerId: string, restartId: string) => Promise<void>;
  readonly escalateServerDrain: () => boolean;
  readonly pendingRunnerRestart: (runnerId: string) => string | undefined;
  readonly prepareServerShutdown: () => Promise<void>;
  readonly recover: (
    launchPending: (runnerId?: string) => void,
    runnerId?: string,
  ) => void;
  readonly resumeRunner: (runnerId: string, restartId: string) => boolean;
}

interface BoundedDrain {
  readonly bounded: Promise<void>;
  readonly escalate: () => void;
  readonly finish: () => void;
  readonly timer: RestartTimer;
}

export function createSessionRestartControl(
  runtimes: RestartRuntimeControl,
  generateRestartId: () => string,
  options: Partial<RestartDrainOptions> = {},
): SessionRestartControl {
  const setDrainTimer = options.setTimeout ?? setRestartTimer;
  const clearDrainTimer = options.clearTimeout ?? clearRestartTimer;
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message);
    });
  const pendingTools = options.pendingTools ?? (() => []);
  const drainProgress = (
    scope?: RestartScope,
  ): readonly RestartDrainSessionProgress[] =>
    runtimes
      .drainProgress(scope)
      .slice(0, 100)
      .map((progress) => ({
        ...progress,
        tools: [...new Set(pendingTools(progress.sessionId))].slice(0, 100),
      }));
  const serverRestartId = (): string | undefined => {
    const existing = runtimes.drainRequest({ kind: "server" });
    return existing?.requestedBy === "server" ? existing.restartId : undefined;
  };
  const runnerRestart = (runnerId: string): RestartRequest | undefined =>
    runtimes.drainRequest({ kind: "runner", runnerId });
  const runnerRestartId = (runnerId: string): string | undefined =>
    runnerRestart(runnerId)?.restartId;
  const validRestartId = (restartId: string): string => {
    if (!isValidRestartId(restartId)) {
      throw new Error("The restart ID is invalid");
    }
    return restartId;
  };
  const generatedRestartId = (): string => validRestartId(generateRestartId());
  const nextServerRestartId = (): string =>
    serverRestartId() ?? generatedRestartId();
  let finalShutdownPrepared = false;
  const boundedDrains = new Map<string, BoundedDrain>();
  const forcePark = (
    scope: RestartScope,
    requested: Promise<unknown>,
  ): Promise<void> =>
    requested.then(async () => {
      const report = restartProgressReport(drainProgress(scope));
      const parked = await runtimes.forcePark(scope);
      if (parked.length > 0) {
        warn(
          `Q Mush force-parked ${String(parked.length)} session(s) still running at the restart drain limit: ${report}`,
        );
      }
    });
  const boundedDrain = (
    scope: RestartScope,
    restartId: string,
    durable: boolean,
  ): Promise<void> => {
    const key = scope.kind === "server" ? "server" : `runner:${scope.runnerId}`;
    const existing = boundedDrains.get(key);
    if (existing !== undefined) {
      existing.escalate();
      return existing.bounded;
    }
    const requested = runtimes.requestDrain(scope, restartId, durable);
    const escalation = Promise.withResolvers<undefined>();
    let escalated = false;
    const finish = () => {
      escalation.resolve(undefined);
    };
    const escalate = () => {
      if (escalated || finalShutdownPrepared) return;
      escalated = true;
      void forcePark(scope, requested).then(finish, escalation.reject);
    };
    const timer = setDrainTimer(escalate, RESTART_DRAIN_LIMIT_MS);
    const bounded = Promise.race([
      requested.then(({ settled }) => settled),
      escalation.promise,
    ])
      .then(() => undefined)
      .finally(() => {
        clearDrainTimer(timer);
        boundedDrains.delete(key);
      });
    boundedDrains.set(key, { bounded, escalate, finish, timer });
    return bounded;
  };
  return {
    accepts: (runnerId) => runtimes.accepts(runnerId),
    blockRunner: (runnerId) => {
      runtimes.blockRunner(runnerId);
    },
    resumeRunner: (runnerId, restartId) => {
      if (runnerRestartId(runnerId) !== restartId) {
        return false;
      }
      return runtimes.resumeRunner(runnerId, restartId);
    },
    cancelBoundedRunnerDrains: () => {
      finalShutdownPrepared = true;
      for (const [key, drain] of boundedDrains) {
        if (key.startsWith("runner:")) {
          clearDrainTimer(drain.timer);
          drain.finish();
        }
      }
    },
    drainProgress,
    drainServer: async () => {
      await boundedDrain({ kind: "server" }, nextServerRestartId(), true);
    },
    drainServerFinal: () =>
      runtimes
        .drain({ kind: "server" }, nextServerRestartId())
        .then(() => undefined),
    escalateServerDrain: () => {
      const drain = boundedDrains.get("server");
      drain?.escalate();
      return drain !== undefined;
    },
    prepareServerShutdown: async () => {
      await runtimes.mark({ kind: "server" }, nextServerRestartId());
      finalShutdownPrepared = true;
    },
    drainRunner: async (runnerId, restartId) => {
      validRestartId(restartId);
      if (runtimes.draining) {
        const id = serverRestartId();
        if (id === undefined) {
          throw new Error("The server restart request was lost");
        }
        await boundedDrain({ kind: "server" }, id, true);
        return;
      }
      await boundedDrain({ kind: "runner", runnerId }, restartId, false);
    },
    draining: () => runtimes.draining,
    pendingRunnerRestart: (runnerId) => runnerRestartId(runnerId),
    restoreRunner: (runnerId, restartId) =>
      runtimes.restoreRunner(runnerId, validRestartId(restartId)),
    recover: (launchPending, runnerId) => {
      runtimes.start(runnerId);
      launchPending(runnerId);
    },
  };
}

interface SessionRestartCredentialReader {
  readonly readCredential: (
    userId: string,
    credentialId: string,
    workspaceId?: string,
  ) =>
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

export type SessionRestartCredentialReaders = Readonly<
  Record<"openai" | "openrouter", SessionRestartCredentialReader> &
    Partial<
      Record<Extract<ProviderId, "generic">, SessionRestartCredentialReader>
    >
>;

export async function readSessionRestartCredential(
  readers: SessionRestartCredentialReaders,
  userId: string,
  selection: RestartCredentialSelection,
): Promise<ProviderCredentialAccess | undefined> {
  const reader = readers[selection.provider];
  try {
    return await reader?.readCredential(
      userId,
      selection.credentialId,
      selection.workspaceId,
    );
  } catch {
    return undefined;
  }
}
