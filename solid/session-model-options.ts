import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { CustomSelectOption } from "./custom-select.tsx";

export interface ModelCredentialIdentity {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

export interface ModelCredentialOption extends ModelCredentialIdentity {
  readonly label: string;
}

export function modelCredentialValue(
  credential: ModelCredentialIdentity,
): string {
  return `${credential.provider}:${credential.credentialId}`;
}

export function parseModelCredentialValue(
  value: string,
): ModelCredentialIdentity | undefined {
  const [provider, ...identityParts] = value.split(":");
  const credentialId = identityParts.join(":");
  if (credentialId.length === 0) return undefined;
  switch (provider) {
    case "openai":
    case "openrouter":
      return { credentialId, provider };
    case undefined:
    default:
      return undefined;
  }
}

export function modelCredentialOptions(
  credentials: readonly ModelCredentialOption[],
): readonly CustomSelectOption[] {
  return credentials.map((credential) => ({
    label: `${credential.provider === "openai" ? "OpenAI" : "OpenRouter"} · ${credential.label}`,
    value: modelCredentialValue(credential),
  }));
}

export function modelCatalogOptions(
  catalog: AgentModelCatalog | undefined,
): readonly CustomSelectOption[] {
  return catalog?.models.map(({ id, label }) => ({ label, value: id })) ?? [];
}
