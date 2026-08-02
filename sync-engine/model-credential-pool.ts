import { CredentialPoolBalancer } from "../shared/credential-pool-balancer.ts";
import type { AppDatabase } from "../shared/database.ts";
import { isBalancedCredentialId } from "../shared/provider-credential-pool.ts";
import {
  ProviderCredentialStore,
  type ProviderCredentialAccess,
  type ProviderId,
} from "../shared/provider-credential-store.ts";
import { isCredentialRejectionError } from "./agent-model-discovery.ts";

interface BalancedCredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly workspaceId?: string;
}

export interface ModelCredentialPoolDependencies {
  readonly database: AppDatabase;
  readonly readCredential: (
    userId: string,
    selection: BalancedCredentialSelection,
  ) => Promise<ProviderCredentialAccess | undefined>;
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

  async representative(
    userId: string,
    selection: BalancedCredentialSelection,
  ): Promise<readonly ProviderCredentialAccess[]> {
    if (!isBalancedCredentialId(selection.provider, selection.credentialId)) {
      return this.candidates(userId, selection);
    }
    const summaries = ProviderCredentialStore.listActiveModelCredentials(
      this.#dependencies.database,
      userId,
      selection.provider,
      selection.workspaceId,
    );
    const credentials: ProviderCredentialAccess[] = [];
    for (const summary of summaries) {
      try {
        const credential = await this.#dependencies.readCredential(userId, {
          ...selection,
          credentialId: summary.id,
        });
        if (credential !== undefined) credentials.push(credential);
      } catch {
        // A later member can still provide the shared provider catalog.
      }
    }
    return credentials;
  }

  async candidates(
    userId: string,
    selection: BalancedCredentialSelection,
  ): Promise<readonly ProviderCredentialAccess[]> {
    if (!isBalancedCredentialId(selection.provider, selection.credentialId)) {
      const credential = await this.#dependencies.readCredential(
        userId,
        selection,
      );
      return credential === undefined ? [] : [credential];
    }
    const pool = this.#poolKey(userId, selection);
    const summaries = ProviderCredentialStore.listActiveModelCredentials(
      this.#dependencies.database,
      userId,
      selection.provider,
      selection.workspaceId,
    );
    const credentials: ProviderCredentialAccess[] = [];
    for (const summary of this.#balancer.ordered(pool, summaries)) {
      try {
        const credential = await this.#dependencies.readCredential(userId, {
          ...selection,
          credentialId: summary.id,
        });
        if (credential !== undefined) credentials.push(credential);
      } catch {
        this.#balancer.coolDown(pool, summary.id);
      }
    }
    return credentials;
  }

  reject(
    userId: string,
    selection: BalancedCredentialSelection,
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

  #poolKey(userId: string, selection: BalancedCredentialSelection): string {
    return [userId, selection.workspaceId ?? "", selection.provider].join(":");
  }
}
