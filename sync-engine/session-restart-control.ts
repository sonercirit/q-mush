import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionRuntimes } from "./session-runtime.ts";

export interface SessionRestartControl {
  readonly accepts: (runnerId: string) => boolean;
  readonly draining: () => boolean;
  readonly drainServer: () => Promise<void>;
  readonly drainRunner: (
    ...parameters: readonly [string, string]
  ) => Promise<unknown>;
  readonly recover: (
    launchPending: (runnerId?: string) => void,
    runnerId?: string,
  ) => void;
}

export function createSessionRestartControl(
  runtimes: SessionRuntimes,
  generateRestartId: () => string,
): SessionRestartControl {
  const serverRestartId = (): string | undefined => {
    const existing = runtimes.drainRequest({ kind: "server" });
    return existing?.requestedBy === "server" ? existing.restartId : undefined;
  };
  const generatedRestartId = (): string => {
    const restartId = generateRestartId();
    if (restartId.length > 200 || restartId === "") {
      throw new Error("The restart ID is invalid");
    }
    return restartId;
  };
  const nextServerRestartId = (): string =>
    serverRestartId() ?? generatedRestartId();
  return {
    accepts: (runnerId) => runtimes.accepts(runnerId),
    drainServer: () =>
      runtimes.drain({ kind: "server" }, nextServerRestartId()),
    drainRunner: async (runnerId, restartId) => {
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
    recover: (launchPending, runnerId) => {
      if (runnerId === undefined) {
        runtimes.serverStarted();
      } else {
        runtimes.runnerConnected(runnerId);
      }
      launchPending(runnerId);
    },
  };
}

interface SessionRestartCredentialReader {
  readonly readCredential: (
    userId: string,
    credentialId: string,
  ) =>
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

type SessionRestartCredentialReaders = Readonly<
  Record<"openai" | "openrouter", SessionRestartCredentialReader>
>;

export async function readSessionRestartCredential(
  readers: SessionRestartCredentialReaders,
  userId: string,
  selection: Pick<AgentSessionDetail, "credentialId" | "provider">,
): Promise<ProviderCredentialAccess | undefined> {
  const reader = readers[selection.provider];
  try {
    const credential = reader.readCredential(userId, selection.credentialId);
    return await credential;
  } catch {
    return undefined;
  }
}
