import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import type { RunnerSummary } from "../../shared/runner-model.ts";
import type { ProviderCredential } from "../provider-client.tsx";

const POSITIONS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
] as const;

export function numberedCredentials(): readonly ProviderCredential[] {
  return POSITIONS.map((position) => ({
    accountId: `account-${position}`,
    id: `credential-${position}`,
    isDefault: false,
    label: `Credential ${position}`,
    limits: { status: "unavailable" },
    source: "api_key",
  }));
}

export function numberedModels(): AgentModelCatalog["models"] {
  return POSITIONS.map((position) => ({
    contextWindow: Number(position) * 1_000,
    id: `model-${position}`,
    inputModalities: position === "12" ? ["text", "image"] : ["text"],
    label: `Model ${position}`,
    outputModalities: ["text"],
    pricing: null,
    reasoningEfforts: ["high"],
  }));
}

export function numberedRunners(): readonly RunnerSummary[] {
  return POSITIONS.map((position) => ({
    architecture: "x64",
    id: `runner-${position}`,
    isDefault: false,
    lastSeenAt: 1,
    name: `Runner ${position}`,
    platform: "linux",
    status: "online",
  }));
}
