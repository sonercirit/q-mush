import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { ProviderCredential } from "./provider-client.tsx";

export interface SessionCredentialOption {
  readonly credential: ProviderCredential;
  readonly provider: ProviderId;
}
