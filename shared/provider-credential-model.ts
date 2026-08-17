import type { ProviderApiFormat, ProviderId } from "./provider-id.ts";

export type ProviderCredentialSource = "api_key" | "oauth";
export type CredentialProviderId = ProviderId | "brave_search";

export interface ProviderCredentialDetails {
  readonly accountId: string | null;
  readonly apiFormat?: ProviderApiFormat;
  readonly baseUrl?: string;
  readonly label: string;
}

export interface ProviderCredentialSummary extends ProviderCredentialDetails {
  readonly id: string;
  readonly isDefault: boolean;
  readonly isGlobal?: boolean;
  readonly requiresReauthentication?: boolean;
  readonly source: ProviderCredentialSource;
  readonly workspaceIds?: readonly string[];
}

export interface ProviderCredentialAccess extends ProviderCredentialSummary {
  readonly secret: string;
}

export interface ProviderCredentialPage {
  readonly items: readonly (ProviderCredentialSummary & {
    readonly provider: ProviderId;
  })[];
  readonly totalItems: number;
}
