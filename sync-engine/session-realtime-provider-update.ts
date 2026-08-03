import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { isBalancedCredentialId } from "../shared/provider-credential-pool.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionProviderUpdateInput } from "../shared/session-provider-update.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";
import { attemptBalancedCredentials } from "./session-balanced-credential-attempt.ts";
import {
  applySessionProviderUpdate,
  type SessionProviderUpdateDependencies,
} from "./session-provider-update.ts";
import {
  requireCredentialCandidates,
  successfulCredentialAttempt,
} from "./session-realtime-errors.ts";

interface BalancedProviderUpdateDependencies {
  readonly apply: (
    userId: string,
    input: SessionProviderUpdateInput,
    rejectCredentialErrors: boolean,
  ) => Promise<AgentSessionDetail>;
  readonly pool: ModelCredentialPool;
}

export async function updateSessionProviderWithPool(options: {
  readonly dependencies: BalancedProviderUpdateDependencies;
  readonly input: SessionProviderUpdateInput;
  readonly user: AuthenticatedUser;
}): Promise<AgentSessionDetail> {
  const { dependencies, input, user } = options;
  if (!isBalancedCredentialId(input.provider, input.credentialId)) {
    return dependencies.apply(user.id, input, false);
  }
  const credentials = await dependencies.pool.candidates(user.id, input);
  requireCredentialCandidates(credentials);
  return successfulCredentialAttempt(
    attemptBalancedCredentials<AgentSessionDetail, typeof input>({
      credentials,
      dependencies: {
        attempt: (_credential, resolvedInput) =>
          dependencies.apply(user.id, resolvedInput, true),
        pool: dependencies.pool,
      },
      input,
      userId: user.id,
    }),
  );
}

export function applyResolvedSessionProviderUpdate(options: {
  readonly dependencies: Omit<SessionProviderUpdateDependencies, "store">;
  readonly input: SessionProviderUpdateInput;
  readonly store: SessionProviderUpdateDependencies["store"];
  readonly userId: string;
}): Promise<AgentSessionDetail> {
  return applySessionProviderUpdate(
    { ...options.dependencies, store: options.store },
    options.userId,
    options.input,
  );
}
