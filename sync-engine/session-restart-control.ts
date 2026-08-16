import { RESTART_DRAIN_LIMIT_MS } from "../shared/development-shutdown.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
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
  readonly forcePark: (scope: RestartScope) => readonly string[];
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

interface RestartDrainTimers {
  readonly clearTimeout: (id: RestartTimer) => void;
  readonly log: (message: string) => void;
  readonly pendingTools: (sessionId: string) => readonly string[];
  readonly setTimeout: RestartSetTimeout;
}

export interface RestartDrainSessionProgress extends RestartDrainProgress {
  readonly tools: readonly string[];
}

function drainProgressReport(
  progress: readonly RestartDrainSessionProgress[],
): string {
  return progress
    .map(({ elapsedMs, sessionId, tools }) => {
      const waiting = tools.length === 0 ? "no tool call" : tools.join(", ");
      return `${sessionId} (${waiting}, ${String(Math.round(elapsedMs / 1_000))}s)`;
    })
    .join("; ");
}

export interface SessionRestartControl extends Pick<
  RestartRuntimeControl,
  "accepts" | "blockRunner" | "restoreRunner"
> {
  readonly drainProgress: (
    scope?: RestartScope,
  ) => readonly RestartDrainSessionProgress[];
  readonly draining: () => boolean;
  readonly drainServer: () => Promise<void>;
  readonly drainRunner: (runnerId: string, restartId: string) => Promise<void>;
  readonly pendingRunnerRestart: (runnerId: string) => string | undefined;
  readonly prepareServerShutdown: () => Promise<void>;
  readonly recover: (
    launchPending: (runnerId?: string) => void,
    runnerId?: string,
  ) => void;
  readonly resumeRunner: (runnerId: string, restartId: string) => boolean;
}

export function createSessionRestartControl(
  runtimes: RestartRuntimeControl,
  generateRestartId: () => string,
  timers: Partial<RestartDrainTimers> = {},
): SessionRestartControl {
  const setDrainTimer = timers.setTimeout ?? setRestartTimer;
  const clearDrainTimer = timers.clearTimeout ?? clearRestartTimer;
  const log =
    timers.log ??
    ((message: string) => {
      console.log(message);
    });
  const pendingTools = timers.pendingTools ?? (() => []);
  const drainProgress = (
    scope?: RestartScope,
  ): readonly RestartDrainSessionProgress[] =>
    runtimes.drainProgress(scope).map((progress) => ({
      ...progress,
      tools: pendingTools(progress.sessionId),
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
  const boundedDrains = new Map<
    string,
    { readonly bounded: Promise<void>; readonly escalate: () => void }
  >();
  // Bounds one scope's settlement wait: the drain converges when every
  // affected runtime settles, when the limit expires, or as soon as a second
  // request for the same scope escalates it. Force-parking keeps the durable
  // handoffs the request already persisted, so nothing is stopped.
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
    // Registered synchronously so a second request arriving while the first
    // still persists escalates it instead of starting a rival wait.
    const requested = runtimes.requestDrain(scope, restartId, durable);
    const escalation = Promise.withResolvers<undefined>();
    const escalate = () => {
      // Force-parking only after the request settles guarantees each affected
      // runtime already carries its durable handoff.
      void requested.then(
        () => {
          // Reported before force-parking, which aborts the very tool calls
          // the report names.
          const report = drainProgressReport(drainProgress(scope));
          const parked = runtimes.forcePark(scope);
          if (parked.length > 0) {
            log(
              `Q Mush force-parked ${String(parked.length)} session(s) still running at the restart drain limit: ${report}`,
            );
          }
          escalation.resolve(undefined);
        },
        () => {
          escalation.resolve(undefined);
        },
      );
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
    boundedDrains.set(key, { bounded, escalate });
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
    drainServer: async () => {
      const scope = { kind: "server" } as const;
      const restartId = nextServerRestartId();
      if (finalShutdownPrepared) {
        await runtimes.drain(scope, restartId);
        return;
      }
      await boundedDrain(scope, restartId, true);
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
      await boundedDrain({ kind: "runner", runnerId }, restartId, true);
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
