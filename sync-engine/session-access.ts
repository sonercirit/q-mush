import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type {
  RunnerCommandBroker,
  RunnerToolCommand,
} from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  GLOBAL_WORKSPACE_ID,
  isWorkspaceId,
} from "../shared/workspace-model.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { BraveSearchExecutor } from "./brave-search.ts";
import { createApiError } from "./http.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { RunnerIntegration } from "./runners.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";

interface SessionCredentialReader {
  readCredential(
    userId: string,
    credentialId: string,
    workspaceId: string,
  ):
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

export type SessionCredentialReaders = Readonly<
  Record<ProviderId, SessionCredentialReader>
>;

export interface SessionWorkspaceAccess {
  defaultForUser(userId: string): { readonly id: string } | undefined;
  exists(userId: string, workspaceId: string): boolean;
}

export interface SessionDependencies {
  readonly broker?: RunnerCommandBroker;
  readonly braveSearch: BraveSearchExecutor;
  readonly database?: AppDatabase;
  readonly discoverModels?: AgentModelDiscoverer;
  readonly modelFactory?: AgentModelFactory;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
  readonly realtime?: RealtimeHub;
  readonly workspaces?: SessionWorkspaceAccess;
}

export interface SessionIntegration {
  collection(request: Request): Response | Promise<Response>;
  compact(request: Request, sessionId: string): Promise<Response>;
  compaction(request: Request, sessionId: string): Promise<Response>;
  completeRunnerCommand(
    runnerId: string,
    commandId: string,
    output: string,
  ): boolean;
  continue(request: Request, sessionId: string): Promise<Response>;
  deliverRunnerCommands(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
  ): void;
  detailForUser(
    userId: string,
    sessionId: string,
    workspaceId: string,
  ): AgentSessionDetail | undefined;
  directories(
    request: Request,
    runnerId: string,
    workspaceId?: string | null,
  ): Promise<Response>;
  drain(): Promise<void>;
  item(request: Request, sessionId: string): Response;
  listForUser(
    userId: string,
    workspaceId: string,
  ): readonly AgentSessionSummary[];
  message(request: Request, sessionId: string): Promise<Response>;
  models(request: Request): Promise<Response>;
  onChange(listener: (userId: string, sessionId: string) => void): void;
  runnerConnected(): void;
  stop(request: Request, sessionId: string): Promise<Response>;
}

interface SessionCredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly workspaceId: string;
}

interface SessionRuntimeSelection extends SessionCredentialSelection {
  readonly runnerId: string;
}

type SessionCredentialAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

export class SessionAccess {
  readonly #providers: SessionCredentialReaders;
  readonly #runners: RunnerIntegration;
  readonly #workspaces: SessionWorkspaceAccess;

  constructor(
    providers: SessionCredentialReaders,
    runners: RunnerIntegration,
    workspaces: SessionWorkspaceAccess,
  ) {
    this.#providers = providers;
    this.#runners = runners;
    this.#workspaces = workspaces;
  }

  async credential(
    userId: string,
    selection: SessionCredentialSelection,
    action: SessionCredentialAction,
  ): Promise<Response> {
    if (
      !isWorkspaceId(selection.workspaceId) ||
      selection.workspaceId === GLOBAL_WORKSPACE_ID ||
      !this.#workspaces.exists(userId, selection.workspaceId)
    ) {
      return createApiError("workspace_unavailable", 409);
    }
    let credential: ProviderCredentialAccess | undefined;
    try {
      credential = await this.#providers[selection.provider].readCredential(
        userId,
        selection.credentialId,
        selection.workspaceId,
      );
    } catch {
      return createApiError("credential_refresh_failed", 502);
    }
    return credential === undefined
      ? createApiError("credential_unavailable", 409)
      : action(credential);
  }

  async runtime(
    userId: string,
    selection: SessionRuntimeSelection,
    action: SessionCredentialAction,
  ): Promise<Response> {
    if (
      !this.#workspaces.exists(userId, selection.workspaceId) ||
      !this.#runners.runnerIsAvailable(
        userId,
        selection.runnerId,
        selection.workspaceId,
      )
    ) {
      return createApiError("runner_unavailable", 409);
    }
    return this.credential(userId, selection, action);
  }
}
