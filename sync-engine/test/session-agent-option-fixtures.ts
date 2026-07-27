import type {
  AgentModelCatalog,
  AgentModelOption,
} from "../../shared/agent-configuration.ts";
import type { ProviderCredentialAccess } from "../../shared/provider-credential-store.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import type {
  GetSessionOptionsToolInput,
  SessionOptionsSource,
} from "../../sync-engine/session-agent-options.ts";
import {
  jsonRecord,
  records,
  testString,
} from "./session-agent-output-helpers.ts";
import { findToolResultContents } from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  type startToolSession,
} from "./session-agent-tool-setup.ts";

export function testCredential(
  id: string,
  secret: string,
): ProviderCredentialAccess {
  return {
    accountId: null,
    id,
    isDefault: false,
    label: id,
    secret,
    source: "api_key",
  };
}

export function testModelOption(
  id: string,
  overrides: Partial<AgentModelOption> = {},
): AgentModelOption {
  return testAgentModelOption({
    contextWindow: null,
    id,
    label: `Model ${id}`,
    ...overrides,
  });
}

export function testSessionOptionsSource(
  overrides: Partial<SessionOptionsSource> = {},
): SessionOptionsSource {
  return {
    credentials: [],
    models: [],
    reasoningEfforts: [],
    runners: [],
    tools: [],
    ...overrides,
  };
}

export const testSessionOptionsInput = (
  category: GetSessionOptionsToolInput["category"],
  overrides: Partial<GetSessionOptionsToolInput> = {},
): GetSessionOptionsToolInput => ({ category, page: 1, ...overrides });

export function modelOptionIds(
  output: Readonly<Record<string, unknown>>,
): readonly string[] {
  return records(output["items"]).map((item) => testString(item["id"]));
}

export async function sessionOptionOutputs(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const detail = await completedParentDetail(setup, "idle");
  return findToolResultContents(detail, "get_session_options").map((output) =>
    output.startsWith("Error:") ? { error: output } : jsonRecord(output),
  );
}

export function containsAny(
  value: string,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

export function catalog(
  models: readonly AgentModelOption[],
): Promise<AgentModelCatalog> {
  return Promise.resolve({ defaultModel: models[0]?.id ?? null, models });
}
