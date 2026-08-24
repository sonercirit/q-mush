import { AGENT_REASONING_EFFORTS } from "../shared/agent-configuration.ts";
import { AGENT_SESSION_TOOL_OPTIONS } from "../shared/agent-tools.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  balancedCredentialId,
  isBalancedCredentialId,
} from "../shared/provider-credential-pool.ts";
import {
  type ProviderCredentialAccess,
  listActiveModelCredentials,
  hasActiveModelCredential,
  listModelCredentials,
} from "../shared/provider-credential-store.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { throwIfSignalAborted } from "../shared/validation.ts";
import { safeAgentModelDiscoveryError } from "./agent-model-discovery-fetch.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";
import type { SessionAgentActionDependencies } from "./session-agent-action-helpers.ts";
import {
  SESSION_OPTIONS_PAGE_SIZE,
  sessionOptionsOutput,
  sessionOptionsPageFilter,
  type GetSessionOptionsToolInput,
  type SessionOptionsSource,
} from "./session-agent-options.ts";

import { captureRestartSignal } from "./session-restart-gate.ts";
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
  readonly restartSignal: () => AbortSignal;
}

async function singleCredential(
  dependencies: SessionAgentOptionDependencies,
  userId: string,
  selection: Parameters<SessionAgentActionDependencies["readCredential"]>[1],
  signal: AbortSignal | undefined,
): Promise<readonly ProviderCredentialAccess[]> {
  let credential;
  try {
    throwIfSignalAborted(signal, "Model option discovery was canceled");
    credential = await dependencies.readCredential(userId, selection);
    throwIfSignalAborted(signal, "Model option discovery was canceled");
  } catch {
    throwIfSignalAborted(signal, "Model option discovery was canceled");
    return [];
  }
  return credential?.id === selection.credentialId ? [credential] : [];
}

async function modelOptions(
  dependencies: SessionAgentOptionDependencies,
  userId: string,
  input: GetSessionOptionsToolInput,
  workspaceId: string,
  signal: AbortSignal | undefined,
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
    !hasActiveModelCredential(
      dependencies.database,
      userId,
      selection.provider,
      selection.credentialId,
      workspaceId,
    )
  ) {
    throw new Error("The model credential or provider is unavailable");
  }
  const { signal: restartSignal } = captureRestartSignal(
    dependencies.restartSignal,
  );
  const credentials =
    balanced && dependencies.modelCredentialPool !== undefined
      ? await dependencies.modelCredentialPool.representative(
          userId,
          selection,
          signal,
        )
      : await singleCredential(dependencies, userId, selection, signal);
  throwIfSignalAborted(signal, "Model option discovery was canceled");
  if (credentials.length === 0) {
    throw new Error("The model credential or provider is unavailable");
  }
  let failure: unknown;
  for (const credential of credentials) {
    try {
      return (
        await dependencies.discoverModels(
          selection.provider,
          credential,
          signal === undefined
            ? restartSignal
            : AbortSignal.any([signal, restartSignal]),
        )
      ).models;
    } catch (error) {
      throwIfSignalAborted(signal, "Model option discovery was canceled");
      if (restartSignal.aborted) throw error;
      failure = error;
    }
  }
  throw new Error(safeAgentModelDiscoveryError(failure), { cause: failure });
}

function balancedCredentials(
  dependencies: SessionAgentOptionDependencies,
  userId: string,
  workspaceId: string,
): SessionOptionsSource["credentials"] {
  return (["openai", "openrouter", "generic"] as const).flatMap((provider) => {
    const count = listActiveModelCredentials(
      dependencies.database,
      userId,
      provider,
      workspaceId,
    ).length;
    return count < 2
      ? []
      : [
          {
            accountId: null,
            id: balancedCredentialId(provider),
            isDefault: false,
            label: `Balanced (${String(count)} accounts)`,
            provider,
            source: "api_key" as const,
          },
        ];
  });
}

function credentialOptions(
  dependencies: SessionAgentOptionDependencies,
  userId: string,
  input: GetSessionOptionsToolInput,
  workspaceId: string,
) {
  if (input.category !== "credentials") return undefined;
  const offset = optionsPageOffset(input.page);
  const balanced = balancedCredentials(
    dependencies,
    userId,
    workspaceId,
  ).filter(
    ({ id, label, provider }) =>
      input.search === undefined ||
      [id, label, provider].some((value) =>
        value
          .toLocaleLowerCase()
          .includes(input.search?.toLocaleLowerCase() ?? ""),
      ),
  );
  const regularOffset = Math.max(0, offset - balanced.length);
  const regularLimit = Math.max(
    1,
    SESSION_OPTIONS_PAGE_SIZE - Math.max(0, balanced.length - offset),
  );
  const regular = listModelCredentials(
    dependencies.database,
    userId,
    regularOffset,
    regularLimit,
    input.search,
    workspaceId,
  );
  return {
    items: [
      ...balanced.slice(offset, offset + SESSION_OPTIONS_PAGE_SIZE),
      ...regular.items,
    ].slice(0, SESSION_OPTIONS_PAGE_SIZE),
    totalItems: balanced.length + regular.totalItems,
  };
}

export async function sessionAgentOptions(options: {
  readonly dependencies: SessionAgentOptionDependencies;
  readonly input: GetSessionOptionsToolInput;
  readonly signal?: AbortSignal;
  readonly userId: string;
  readonly workspaceId: string;
}): Promise<string> {
  const { dependencies, input, userId, workspaceId } = options;
  const models = await modelOptions(
    dependencies,
    userId,
    input,
    workspaceId,
    options.signal,
  );
  const offset = optionsPageOffset(input.page);
  const credentialPage = credentialOptions(
    dependencies,
    userId,
    input,
    workspaceId,
  );
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
