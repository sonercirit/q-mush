import { AGENT_REASONING_EFFORTS } from "../shared/agent-configuration.ts";
import { AGENT_SESSION_TOOL_OPTIONS } from "../shared/agent-tools.ts";
import type { AppDatabase } from "../shared/database.ts";
import { isBalancedCredentialId } from "../shared/provider-credential-pool.ts";
import {
  ProviderCredentialStore,
  type ProviderCredentialAccess,
} from "../shared/provider-credential-store.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { safeAgentModelDiscoveryError } from "./agent-model-discovery.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";
import type { SessionAgentActionDependencies } from "./session-agent-action-helpers.ts";
import {
  SESSION_OPTIONS_PAGE_SIZE,
  sessionOptionsOutput,
  sessionOptionsPageFilter,
  type GetSessionOptionsToolInput,
  type SessionOptionsSource,
} from "./session-agent-options.ts";

const optionsPageOffset = (page: number): number =>
  (page - 1) * SESSION_OPTIONS_PAGE_SIZE;

export interface SessionRunnerPageRequest {
  readonly limit: number;
  readonly offset: number;
  readonly search?: string;
  readonly workspaceId?: string;
}

interface SessionAgentOptionDependencies {
  readonly database: AppDatabase;
  readonly discoverModels: SessionAgentActionDependencies["discoverModels"];
  readonly listRunnerOptions: (
    userId: string,
    request: SessionRunnerPageRequest,
  ) => {
    readonly items: readonly RunnerSummary[];
    readonly totalItems: number;
  };
  readonly modelCredentialPool?: ModelCredentialPool;
  readonly readCredential: SessionAgentActionDependencies["readCredential"];
}

async function singleCredential(
  dependencies: SessionAgentOptionDependencies,
  userId: string,
  selection: Parameters<SessionAgentActionDependencies["readCredential"]>[1],
): Promise<readonly ProviderCredentialAccess[]> {
  let credential;
  try {
    credential = await dependencies.readCredential(userId, selection);
  } catch {
    return [];
  }
  return credential?.id === selection.credentialId ? [credential] : [];
}

async function modelOptions(
  dependencies: SessionAgentOptionDependencies,
  userId: string,
  input: GetSessionOptionsToolInput,
  workspaceId: string,
): Promise<SessionOptionsSource["models"]> {
  if (
    input.category !== "models" ||
    input.credentialId === undefined ||
    input.provider === undefined
  ) {
    return [];
  }
  const selection = {
    credentialId: input.credentialId,
    provider: input.provider,
    workspaceId,
  };
  const balanced = isBalancedCredentialId(
    selection.provider,
    selection.credentialId,
  );
  if (
    !balanced &&
    !ProviderCredentialStore.hasActiveModelCredential(
      dependencies.database,
      userId,
      selection.provider,
      selection.credentialId,
      workspaceId,
    )
  ) {
    throw new Error("The model credential or provider is unavailable");
  }
  const credentials =
    balanced && dependencies.modelCredentialPool !== undefined
      ? await dependencies.modelCredentialPool.representative(userId, selection)
      : await singleCredential(dependencies, userId, selection);
  if (credentials.length === 0) {
    throw new Error("The model credential or provider is unavailable");
  }
  let failure: unknown;
  for (const credential of credentials) {
    try {
      return (await dependencies.discoverModels(selection.provider, credential))
        .models;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(safeAgentModelDiscoveryError(failure), { cause: failure });
}

export async function sessionAgentOptions(options: {
  readonly dependencies: SessionAgentOptionDependencies;
  readonly input: GetSessionOptionsToolInput;
  readonly userId: string;
  readonly workspaceId: string;
}): Promise<string> {
  const { dependencies, input, userId, workspaceId } = options;
  const models = await modelOptions(dependencies, userId, input, workspaceId);
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
    reasoningEfforts:
      input.category === "models" ? [] : AGENT_REASONING_EFFORTS,
    runners: runnerPage?.items ?? [],
    tools: AGENT_SESSION_TOOL_OPTIONS,
  });
}
