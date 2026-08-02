import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { RestartCredentialSelection } from "./session-restart-recovery.ts";
import {
  isValidRestartId,
  type RestartRequest,
  type RestartScope,
} from "./session-runtime.ts";

export interface RestartRuntimeControl {
  readonly accepts: (runnerId: string) => boolean;
  readonly blockRunner: (runnerId: string) => void;
  readonly drain: (scope: RestartScope, restartId: string) => Promise<unknown>;
  readonly mark: (scope: RestartScope, restartId: string) => Promise<unknown>;
  readonly drainRequest: (scope: RestartScope) => RestartRequest | undefined;
  readonly draining: boolean;
  readonly resumeRunner: (runnerId: string, restartId: string) => boolean;
  readonly restoreRunner: (runnerId: string, restartId: string) => boolean;
  readonly start: (runnerId?: string) => void;
}

export interface SessionRestartControl extends Pick<
  RestartRuntimeControl,
  "accepts" | "blockRunner" | "restoreRunner"
> {
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
): SessionRestartControl {
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
    drainServer: async () => {
      await runtimes.drain({ kind: "server" }, nextServerRestartId());
    },
    prepareServerShutdown: async () => {
      await runtimes.mark({ kind: "server" }, nextServerRestartId());
    },
    drainRunner: async (runnerId, restartId) => {
      validRestartId(restartId);
      if (runtimes.draining) {
        const id = serverRestartId();
        if (id === undefined) {
          throw new Error("The server restart request was lost");
        }
        await runtimes.drain({ kind: "server" }, id);
        return;
      }
      await runtimes.drain({ kind: "runner", runnerId }, restartId);
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
