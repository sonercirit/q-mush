import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";

export interface CredentialDiscoveryRequestOptions<WithCredential> {
  readonly request: Request;
  readonly signal?: AbortSignal;
  readonly user: AuthenticatedUser;
  readonly withCredential: WithCredential;
}

export interface PooledCredentialDiscoveryRequestOptions<
  WithCredential,
> extends CredentialDiscoveryRequestOptions<WithCredential> {
  readonly pool: Pick<ModelCredentialPool, "representative">;
}
