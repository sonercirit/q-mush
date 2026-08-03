import type {
  AgentModelCatalog,
  AgentReasoningEffort,
} from "../shared/agent-configuration.ts";
import { balancedCredentialId } from "../shared/provider-credential-pool.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { CustomSelectOption } from "./custom-select.tsx";

export interface SessionModelDiscoveryFailure {
  readonly error: string;
}

export type SessionModelDiscoveryResult =
  AgentModelCatalog | SessionModelDiscoveryFailure;

export type SessionModelDiscoverer = (
  provider: ProviderId,
  credentialId: string,
) => Promise<SessionModelDiscoveryResult>;

export interface ModelCredentialIdentity {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

export interface ModelCredentialOption extends ModelCredentialIdentity {
  readonly label: string;
}

const MODEL_CREDENTIAL_DELIMITER = ":";

export function modelCredentialValue(
  credential: ModelCredentialIdentity,
): string {
  return [credential.provider, credential.credentialId].join(
    MODEL_CREDENTIAL_DELIMITER,
  );
}

export function parseModelCredentialValue(
  value: string,
): ModelCredentialIdentity | undefined {
  const [provider, ...identityParts] = value.split(MODEL_CREDENTIAL_DELIMITER);
  const credentialId = identityParts.join(":");
  if (credentialId.length === 0) return undefined;
  switch (provider) {
    case "generic":
    case "openai":
    case "openrouter":
      return { credentialId, provider };
    case undefined:
    default:
      return undefined;
  }
}

export function modelProviderLabel(provider: ProviderId): string {
  switch (provider) {
    case "generic":
      return "Generic LLM";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
  }
}

export function modelCredentialOptions(
  credentials: readonly ModelCredentialOption[],
): readonly CustomSelectOption[] {
  const counts = new Map<ProviderId, number>();
  for (const credential of credentials) {
    counts.set(credential.provider, (counts.get(credential.provider) ?? 0) + 1);
  }
  const addedPools = new Set<ProviderId>();
  return credentials.flatMap((credential) => {
    const count = counts.get(credential.provider) ?? 0;
    const pool =
      count >= 2 && !addedPools.has(credential.provider)
        ? [
            {
              label: `${modelProviderLabel(credential.provider)} · Balanced (${String(count)} accounts)`,
              value: modelCredentialValue({
                credentialId: balancedCredentialId(credential.provider),
                provider: credential.provider,
              }),
            },
          ]
        : [];
    addedPools.add(credential.provider);
    return [
      ...pool,
      {
        label: `${modelProviderLabel(credential.provider)} · ${credential.label}`,
        value: modelCredentialValue(credential),
      },
    ];
  });
}

export function reasoningModelOptions(
  catalog: AgentModelCatalog | undefined,
  model: string,
): readonly CustomSelectOption[] {
  const efforts: readonly AgentReasoningEffort[] =
    catalog?.models.find(({ id }) => id === model)?.reasoningEfforts ?? [];
  return [
    { label: "Model default", value: "" },
    ...efforts.map((effort) => ({ label: effort, value: effort })),
  ];
}

export function modelCatalogOptions(
  catalog: AgentModelCatalog | undefined,
): readonly CustomSelectOption[] {
  return catalog?.models.map(({ id, label }) => ({ label, value: id })) ?? [];
}
