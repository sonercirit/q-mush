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
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";

interface SessionCredentialReader {
  readCredential(
    userId: string,
    credentialId: string,
  ):
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

export type SessionCredentialReaders = Readonly<
  Record<ProviderId, SessionCredentialReader>
>;

export interface SessionDependencies {
  readonly broker?: RunnerCommandBroker;
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly database?: AppDatabase;
  readonly discoverModels?: AgentModelDiscoverer;
  readonly modelFactory?: AgentModelFactory;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
  readonly realtime?: RealtimeHub;
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
  ): AgentSessionDetail | undefined;
  directories(request: Request, runnerId: string): Promise<Response>;
  drain(): Promise<void>;
  item(request: Request, sessionId: string): Response;
  listForUser(userId: string): readonly AgentSessionSummary[];
  message(request: Request, sessionId: string): Promise<Response>;
  models(request: Request): Promise<Response>;
  onChange(listener: (userId: string, sessionId: string) => void): void;
  runnerConnected(): void;
  runnerDisconnected(runnerId: string): void;
  stop(request: Request, sessionId: string): Promise<Response>;
}
