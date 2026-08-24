import { createCredentialPoolBalancer } from "../shared/credential-pool-balancer.ts";
import type { AppDatabase } from "../shared/database.ts";
import { isBalancedCredentialId } from "../shared/provider-credential-pool.ts";
import {
  ProviderCredentialStore,
  type ProviderCredentialAccess,
} from "../shared/provider-credential-store.ts";
import { throwIfSignalAborted } from "../shared/validation.ts";
import { isCredentialRejectionError } from "./agent-model-discovery-fetch.ts";
import type { SessionCredentialSelection } from "./session-credential-access.ts";

export type ModelCredentialSelection = SessionCredentialSelection;

export interface ModelCredentialPoolDependencies {
  readonly database: AppDatabase;
  readonly readCredential: (
    userId: string,
    selection: ModelCredentialSelection,
  ) => Promise<ProviderCredentialAccess | undefined>;
}

interface CandidateOptions {
  readonly selection: ModelCredentialSelection;
  readonly signal?: AbortSignal;
  readonly userId: string;
}

type SelectModelCredentials = (
  userId: string,
  selection: ModelCredentialSelection,
  signal?: AbortSignal,
) => Promise<readonly ProviderCredentialAccess[]>;

export interface ModelCredentialPool {
  readonly candidates: SelectModelCredentials;
  readonly reject: (
    userId: string,
    selection: ModelCredentialSelection,
    credentialId: string,
    error: unknown,
  ) => boolean;
  readonly representative: SelectModelCredentials;
}

export function createModelCredentialPool(
  dependencies: ModelCredentialPoolDependencies,
  balancer = createCredentialPoolBalancer(),
): ModelCredentialPool {
  const poolKey = (
    userId: string,
    selection: ModelCredentialSelection,
  ): string =>
    [userId, selection.workspaceId ?? "", selection.provider].join(":");

  const readCandidates = async (
    userId: string,
    selection: ModelCredentialSelection,
    summaries: readonly { readonly id: string }[],
    pool?: string,
    signal?: AbortSignal,
  ): Promise<readonly ProviderCredentialAccess[]> => {
    const credentials: ProviderCredentialAccess[] = [];
    for (const summary of summaries) {
      throwIfSignalAborted(signal, "Credential discovery was canceled");
      try {
        const credential = await dependencies.readCredential(userId, {
          ...selection,
          credentialId: summary.id,
        });
        throwIfSignalAborted(signal, "Credential discovery was canceled");
        if (credential !== undefined) credentials.push(credential);
      } catch (error) {
        throwIfSignalAborted(signal, "Credential discovery was canceled");
        if (pool !== undefined && isCredentialRejectionError(error)) {
          balancer.coolDown(pool, summary.id);
        }
      }
    }
    return credentials;
  };

  const candidates = async (
    options: CandidateOptions,
    balance: boolean,
  ): Promise<readonly ProviderCredentialAccess[]> => {
    const { selection, signal, userId } = options;
    if (!isBalancedCredentialId(selection.provider, selection.credentialId)) {
      return readCandidates(
        userId,
        selection,
        [{ id: selection.credentialId }],
        undefined,
        signal,
      );
    }
    const pool = balance ? poolKey(userId, selection) : undefined;
    const summaries = ProviderCredentialStore.listActiveModelCredentials(
      dependencies.database,
      userId,
      selection.provider,
      selection.workspaceId,
    );
    return readCandidates(
      userId,
      selection,
      pool === undefined ? summaries : balancer.ordered(pool, summaries),
      pool,
      signal,
    );
  };

  const selectCandidates = (
    userId: string,
    selection: ModelCredentialSelection,
    signal: AbortSignal | undefined,
    balance: boolean,
  ): Promise<readonly ProviderCredentialAccess[]> =>
    candidates(
      {
        selection,
        ...(signal === undefined ? {} : { signal }),
        userId,
      },
      balance,
    );

  return {
    candidates: (userId, selection, signal) =>
      selectCandidates(userId, selection, signal, true),
    reject: (userId, selection, credentialId, error) => {
      if (
        !isBalancedCredentialId(selection.provider, selection.credentialId) ||
        !isCredentialRejectionError(error)
      ) {
        return false;
      }
      balancer.coolDown(poolKey(userId, selection), credentialId);
      return true;
    },
    representative: (userId, selection, signal) =>
      selectCandidates(userId, selection, signal, false),
  };
}
