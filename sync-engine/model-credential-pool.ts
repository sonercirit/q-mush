import {
  createCredentialPoolBalancer,
  type CredentialPoolBalancer,
} from "../shared/credential-pool-balancer.ts";
import type { AppDatabase } from "../shared/database.ts";
import { isBalancedCredentialId } from "../shared/provider-credential-pool.ts";
import {
  type ProviderCredentialAccess,
  listActiveModelCredentials,
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

export class ModelCredentialPool {
  readonly #balancer: CredentialPoolBalancer;
  readonly #dependencies: ModelCredentialPoolDependencies;

  constructor(
    dependencies: ModelCredentialPoolDependencies,
    balancer = createCredentialPoolBalancer(),
  ) {
    this.#balancer = balancer;
    this.#dependencies = dependencies;
  }

  async #readCandidates(
    userId: string,
    selection: ModelCredentialSelection,
    summaries: readonly { readonly id: string }[],
    pool?: string,
    signal?: AbortSignal,
  ): Promise<readonly ProviderCredentialAccess[]> {
    const credentials: ProviderCredentialAccess[] = [];
    for (const summary of summaries) {
      throwIfSignalAborted(signal, "Credential discovery was canceled");
      try {
        const credential = await this.#dependencies.readCredential(userId, {
          ...selection,
          credentialId: summary.id,
        });
        throwIfSignalAborted(signal, "Credential discovery was canceled");
        if (credential !== undefined) credentials.push(credential);
      } catch (error) {
        throwIfSignalAborted(signal, "Credential discovery was canceled");
        if (pool !== undefined && isCredentialRejectionError(error)) {
          this.#balancer.coolDown(pool, summary.id);
        }
      }
    }
    return credentials;
  }

  #activeSummaries(userId: string, selection: ModelCredentialSelection) {
    return listActiveModelCredentials(
      this.#dependencies.database,
      userId,
      selection.provider,
      selection.workspaceId,
    );
  }

  async #candidates(
    options: CandidateOptions,
    balance: boolean,
  ): Promise<readonly ProviderCredentialAccess[]> {
    const { selection, signal, userId } = options;
    if (!isBalancedCredentialId(selection.provider, selection.credentialId)) {
      return this.#readCandidates(
        userId,
        selection,
        [{ id: selection.credentialId }],
        undefined,
        signal,
      );
    }
    const pool = balance ? this.#poolKey(userId, selection) : undefined;
    const summaries = this.#activeSummaries(userId, selection);
    return this.#readCandidates(
      userId,
      selection,
      pool === undefined ? summaries : this.#balancer.ordered(pool, summaries),
      pool,
      signal,
    );
  }

  #candidateOptions(
    userId: string,
    selection: ModelCredentialSelection,
    signal?: AbortSignal,
  ): CandidateOptions {
    return {
      selection,
      ...(signal === undefined ? {} : { signal }),
      userId,
    };
  }

  async #selectCandidates(
    userId: string,
    selection: ModelCredentialSelection,
    signal: AbortSignal | undefined,
    balance: boolean,
  ): Promise<readonly ProviderCredentialAccess[]> {
    return this.#candidates(
      this.#candidateOptions(userId, selection, signal),
      balance,
    );
  }

  representative(
    userId: string,
    selection: ModelCredentialSelection,
    signal?: AbortSignal,
  ): Promise<readonly ProviderCredentialAccess[]> {
    return this.#selectCandidates(userId, selection, signal, false);
  }

  candidates(
    ...parameters: readonly [
      userId: string,
      selection: ModelCredentialSelection,
      signal?: AbortSignal,
    ]
  ): Promise<readonly ProviderCredentialAccess[]> {
    const [userId, selection, signal] = parameters;
    return this.#selectCandidates(userId, selection, signal, true);
  }

  reject(
    userId: string,
    selection: ModelCredentialSelection,
    credentialId: string,
    error: unknown,
  ): boolean {
    if (
      !isBalancedCredentialId(selection.provider, selection.credentialId) ||
      !isCredentialRejectionError(error)
    ) {
      return false;
    }
    this.#balancer.coolDown(this.#poolKey(userId, selection), credentialId);
    return true;
  }

  #poolKey(userId: string, selection: ModelCredentialSelection): string {
    return [userId, selection.workspaceId ?? "", selection.provider].join(":");
  }
}
