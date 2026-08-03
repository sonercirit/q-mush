import { AGENT_REASONING_EFFORTS } from "../shared/agent-configuration.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import {
  AGENT_SESSION_TOOL_OPTIONS,
  selectedAgentTools,
} from "../shared/agent-tools.ts";
import { ProviderCredentialStore } from "../shared/provider-credential-store.ts";
import { safeAgentModelDiscoveryError } from "./agent-model-discovery.ts";
import type { SessionAgentActionDependencies } from "./session-agent-action-helpers.ts";
import {
  SESSION_OPTIONS_PAGE_SIZE,
  sessionOptionsOutput,
  sessionOptionsPageFilter,
  type GetSessionOptionsToolInput,
  type SessionOptionsSource,
} from "./session-agent-options.ts";
import {
  readSessionOutput,
  type ReadSessionToolInput,
} from "./session-agent-read.ts";
import { readSessionSnapshot } from "./session-store-agent-read.ts";

interface RunnerPageRequest {
  readonly limit: number;
  readonly offset: number;
  readonly search?: string;
  readonly workspaceId?: string;
}

export interface SessionInspectionDependencies extends SessionAgentActionDependencies {
  readonly listRunnerOptions: (
    userId: string,
    request: RunnerPageRequest,
  ) => {
    readonly items: SessionOptionsSource["runners"];
    readonly totalItems: number;
  };
}

export function readSessionAction(
  dependencies: SessionInspectionDependencies,
  userId: string,
  input: ReadSessionToolInput,
  workspaceId: string,
): string {
  const selected = new Set(input.categories);
  const detail = readSessionSnapshot(dependencies.database, {
    includeSystem: selected.has("system"),
    limit: input.limit,
    roles: (["user", "assistant", "thinking", "tool"] as const).filter((role) =>
      selected.has(role),
    ),
    sessionId: input.sessionId,
    userId,
    workspaceId,
  });
  if (detail === undefined) {
    throw new Error("Session not found");
  }
  return readSessionOutput({
    input,
    matchedRecords: detail.transcript.matchedRecords,
    messages: detail.transcript.messages,
    session: { id: detail.id, status: detail.status, title: detail.title },
    systemPrompt: createAgentSystemPrompt(
      detail.agentFile,
      detail.executionEnvironment,
    ),
    toolDefinitions: selectedAgentTools(detail.tools).map(
      ({ function: definition }) => definition,
    ),
  });
}

const optionsPageOffset = (page: number): number =>
  (page - 1) * SESSION_OPTIONS_PAGE_SIZE;

export async function sessionOptionsAction(
  dependencies: SessionInspectionDependencies,
  userId: string,
  input: GetSessionOptionsToolInput,
  workspaceId: string,
): Promise<string> {
  let models: SessionOptionsSource["models"] = [];
  let reasoningEfforts: SessionOptionsSource["reasoningEfforts"] =
    AGENT_REASONING_EFFORTS;
  if (
    input.category === "models" &&
    input.credentialId !== undefined &&
    input.provider !== undefined
  ) {
    const provider = input.provider;
    const credentialId = input.credentialId;
    if (
      !ProviderCredentialStore.hasActiveModelCredential(
        dependencies.database,
        userId,
        provider,
        credentialId,
        workspaceId,
      )
    ) {
      throw new Error("The model credential or provider is unavailable");
    }
    let credential;
    try {
      credential = await dependencies.readCredential(userId, {
        credentialId,
        provider,
        workspaceId,
      });
    } catch {
      throw new Error("The model credential or provider is unavailable");
    }
    if (credential?.id !== credentialId) {
      throw new Error("The model credential or provider is unavailable");
    }
    try {
      const catalog = await dependencies.discoverModels(provider, credential);
      models = catalog.models;
      reasoningEfforts = [];
    } catch (error) {
      throw new Error(safeAgentModelDiscoveryError(error), { cause: error });
    }
  }
  const offset = optionsPageOffset(input.page);
  const credentialPage =
    input.category === "credentials"
      ? ProviderCredentialStore.listModelCredentials(
          dependencies.database,
          userId,
          offset,
          SESSION_OPTIONS_PAGE_SIZE,
          input.search,
          workspaceId,
        )
      : undefined;
  const runnerPage =
    input.category === "runners"
      ? dependencies.listRunnerOptions(userId, {
          limit: SESSION_OPTIONS_PAGE_SIZE,
          offset,
          ...sessionOptionsPageFilter(input),
          workspaceId,
        })
      : undefined;
  return sessionOptionsOutput(input, {
    credentials: credentialPage?.items ?? [],
    models,
    ...(credentialPage === undefined && runnerPage === undefined
      ? {}
      : {
          page: {
            totalItems:
              credentialPage?.totalItems ?? runnerPage?.totalItems ?? 0,
          },
        }),
    reasoningEfforts,
    runners: runnerPage?.items ?? [],
    tools: AGENT_SESSION_TOOL_OPTIONS,
  });
}
