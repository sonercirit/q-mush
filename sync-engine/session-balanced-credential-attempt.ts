import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type {
  ModelCredentialPool,
  ModelCredentialSelection,
} from "./model-credential-pool.ts";

export interface BalancedCredentialAttemptDependencies<Input, Result> {
  readonly attempt: (
    credential: ProviderCredentialAccess,
    resolvedInput: Input,
  ) => Promise<Result>;
  readonly pool: ModelCredentialPool;
}

export async function attemptBalancedCredentials<
  Result,
  Input extends ModelCredentialSelection,
>(options: {
  readonly dependencies: BalancedCredentialAttemptDependencies<Input, Result>;
  readonly credentials: readonly ProviderCredentialAccess[];
  readonly input: Input;
  readonly userId: string;
}): Promise<Result> {
  const { dependencies, credentials, input, userId } = options;
  let lastFailure: unknown;
  for (const credential of credentials) {
    try {
      const resolved = { ...input, credentialId: credential.id };
      return await dependencies.attempt(credential, resolved);
    } catch (error) {
      lastFailure = error;
      if (!dependencies.pool.reject(userId, input, credential.id, error)) {
        throw error;
      }
    }
  }
  throw lastFailure;
}
