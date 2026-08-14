import { CredentialPoolBalancer } from "../shared/credential-pool-balancer.ts";
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
  readonly pool?: string;
  readonly selection: ModelCredentialSelection;
  readonly signal?: AbortSignal;
  readonly userId: string;
}

export class ModelCredentialPool {
  readonly #balancer: CredentialPoolBalancer;
  readonly #dependencies: ModelCredentialPoolDependencies;

  constructor(
    dependencies: ModelCredentialPoolDependencies,
    balancer = new CredentialPoolBalancer(),
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
    return ProviderCredentialStore.listActiveModelCredentials(
      this.#dependencies.database,
      userId,
      selection.provider,
      selection.workspaceId,
    );
  }

  async #balancedCandidates(
    options: CandidateOptions,
  ): Promise<readonly ProviderCredentialAccess[]> {
    const { pool, selection, signal, userId } = options;
    const summaries = this.#activeSummaries(userId, selection);
    return this.#readCandidates(
      userId,
      selection,
      pool === undefined ? summaries : this.#balancer.ordered(pool, summaries),
      pool,
      signal,
    );
  }

  async #poolOrSingle(
    options: CandidateOptions,
  ): Promise<readonly ProviderCredentialAccess[]> {
    const { selection, signal, userId } = options;
    return isBalancedCredentialId(selection.provider, selection.credentialId)
      ? this.#balancedCandidates(options)
      : this.#readCandidates(
          userId,
          selection,
          [{ id: selection.credentialId }],
          undefined,
          signal,
        );
  }

  async representative(
    userId: string,
    selection: ModelCredentialSelection,
    signal?: AbortSignal,
  ): Promise<readonly ProviderCredentialAccess[]> {
    return this.#poolOrSingle({
      selection,
      ...(signal === undefined ? {} : { signal }),
      userId,
    });
  }

  async candidates(
    userId: string,
    selection: ModelCredentialSelection,
  ): Promise<readonly ProviderCredentialAccess[]> {
    const pool = isBalancedCredentialId(
      selection.provider,
      selection.credentialId,
    )
      ? this.#poolKey(userId, selection)
      : undefined;
    return this.#poolOrSingle({
      ...(pool === undefined ? {} : { pool }),
      selection,
      userId,
    });
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
