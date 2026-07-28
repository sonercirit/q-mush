import type { ProviderId } from "../../shared/provider-credential-store.ts";
import type { SessionCredentialOption } from "../session-credential-option.ts";

export function testSessionCredentialOption(options: {
  readonly id: string;
  readonly label: string;
  readonly provider: ProviderId;
  readonly isDefault?: boolean;
}): SessionCredentialOption {
  return {
    credential: {
      accountId: null,
      id: options.id,
      isDefault: options.isDefault ?? false,
      isGlobal: true,
      label: options.label,
      source: "api_key",
      workspaceIds: [],
    },
    provider: options.provider,
  };
}
