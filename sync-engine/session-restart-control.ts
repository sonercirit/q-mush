import type { ClockedTimeoutOptions } from "../shared/clocked-timeout.ts";
import { DEVELOPMENT_RESTART_LIFECYCLE_MS } from "../shared/development-shutdown.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import { RestartDeadline } from "../shared/restart-deadline.ts";
import { countRestartProgressTools } from "../shared/restart-progress-tools.ts";
import {
  restartProgressReport,
  type RestartProgressTool,
} from "../shared/restart-progress.ts";
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
  readonly forcePark: (
    scope: RestartScope,
    persistence?: Promise<unknown>,
  ) => Promise<readonly string[]>;
  readonly mark: (scope: RestartScope, restartId: string) => Promise<unknown>;
  readonly requestDrain: (
    scope: RestartScope,
    restartId: string,
    durable: boolean,
  ) => RestartDrainSettlement;
  readonly drainRequest: (scope: RestartScope) => RestartRequest | undefined;
  readonly draining: boolean;
  readonly resumeRunner: (runnerId: string, restartId: string) => boolean;
  readonly restoreRunner: (runnerId: string, restartId: string) => boolean;
  readonly start: (runnerId?: string) => void;
}

interface RestartDrainOptions extends ClockedTimeoutOptions<RestartTimer> {
  readonly pendingTools: (sessionId: string) => readonly RestartProgressTool[];
  readonly setTimeout: RestartSetTimeout;
  readonly warn: (message: string) => void;
}

export interface RestartDrainSessionProgress extends RestartDrainProgress {
  readonly tools: readonly RestartProgressTool[];
  readonly totalTools: number;
}

export interface SessionRestartControl extends Pick<
  RestartRuntimeControl,
  "accepts" | "blockRunner" | "restoreRunner"
> {
  readonly drainProgress: (
    scope?: RestartScope,
    includeSession?: (sessionId: string) => boolean,
  ) => readonly RestartDrainSessionProgress[];
  readonly draining: () => boolean;
  readonly drainServer: (deadline?: RestartDeadline) => Promise<void>;
  readonly drainServerFinal: () => Promise<void>;
  readonly drainRunner: (runnerId: string, restartId: string) => Promise<void>;
  readonly escalateRunnerDrain: (
    runnerId: string,
    restartId: string,
  ) => boolean;
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
  const now = options.now ?? Date.now;
  const drainProgress = (
    scope?: RestartScope,
    includeSession: (sessionId: string) => boolean = () => true,
  ): readonly RestartDrainSessionProgress[] =>
    runtimes
      .drainProgress(scope)
      .filter(({ sessionId }) => includeSession(sessionId))
      .slice(0, 100)
      .map((progress) => {
        const pending = pendingTools(progress.sessionId).filter(
          ({ count }) => count > 0,
        );
        const expandedNames = pending.flatMap(({ count, name }) =>
          Array.from({ length: count }, () => name),
        );
        const allTools = countRestartProgressTools(expandedNames);
        return {
          ...progress,
          tools: allTools.slice(0, 100),
          totalTools: allTools.reduce((total, tool) => total + tool.count, 0),
        };
      });
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
    persistence: Promise<unknown>,
  ): Promise<void> =>
    (async () => {
      const report = restartProgressReport(drainProgress(scope));
      const parked = await runtimes.forcePark(scope, persistence);
      if (parked.length > 0) {
        warn(
          `Q Mush force-parked ${String(parked.length)} session(s) still running at the restart drain limit: ${report}`,
        );
      }
    })();
  const escalationKey = (scope: RestartScope): string =>
    scope.kind === "server" ? "server" : `runner:${scope.runnerId}`;
  const escalateScope = (scope: RestartScope): boolean => {
    const drain = boundedDrains.get(escalationKey(scope));
    drain?.escalate();
    return drain !== undefined;
  };
  const boundedDrain = (
    scope: RestartScope,
    restartId: string,
    durable: boolean,
    deadline = new RestartDeadline(
      now() + DEVELOPMENT_RESTART_LIFECYCLE_MS,
      now,
    ),
    escalateExisting = true,
  ): Promise<void> => {
    const key = escalationKey(scope);
    const existing = boundedDrains.get(key);
    if (existing !== undefined) {
      if (escalateExisting) existing.escalate();
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
      void forcePark(scope, requested.persistence).then(
        finish,
        escalation.reject,
      );
    };
    const timeout = setDrainTimer(escalate, deadline.remaining());
    const bounded = Promise.race([requested.settled, escalation.promise])
      .then(() => undefined)
      .finally(() => {
        clearDrainTimer(timeout);
        boundedDrains.delete(key);
      });
    boundedDrains.set(key, { bounded, escalate, finish, timer: timeout });
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
    drainProgress,
    drainServer: async (deadline) => {
      await boundedDrain(
        { kind: "server" },
        nextServerRestartId(),
        true,
        deadline,
      );
    },
    drainServerFinal: () =>
      runtimes
        .drain({ kind: "server" }, nextServerRestartId())
        .then(() => undefined),
    escalateServerDrain: () => escalateScope({ kind: "server" }),
    prepareServerShutdown: async () => {
      finalShutdownPrepared = true;
      for (const drain of boundedDrains.values()) {
        clearDrainTimer(drain.timer);
        drain.finish();
      }
      await runtimes.mark({ kind: "server" }, nextServerRestartId());
    },
    drainRunner: async (runnerId, restartId) => {
      validRestartId(restartId);
      if (runtimes.draining) {
        const serverId = serverRestartId();
        if (serverId === undefined) {
          throw new Error("The server restart request was lost");
        }
        await boundedDrain(
          { kind: "server" },
          serverId,
          true,
          undefined,
          false,
        );
        return;
      }
      await boundedDrain({ kind: "runner", runnerId }, restartId, false);
    },
    draining: () => runtimes.draining,
    escalateRunnerDrain: (runnerId, restartId) => {
      validRestartId(restartId);
      if (runtimes.draining) {
        return escalateScope({ kind: "server" });
      }
      if (runnerRestartId(runnerId) !== restartId) {
        return false;
      }
      return escalateScope({ kind: "runner", runnerId });
    },
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
