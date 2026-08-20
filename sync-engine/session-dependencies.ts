import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import type { SessionWorkspaceReader } from "./session-workspace.ts";
import type { ToolSettingsStore } from "./tool-settings-store.ts";

interface SessionLivenessOptions {
  /** Internal test-only escape hatch for deterministic sub-floor timers. */
  readonly allowUnsafeTestTiming?: boolean;
  /**
   * Pairs with an injected setInterval; without it, stop() cannot clear an
   * injected timer, so only omit it for timers that never fire on their own.
   */
  readonly clearInterval?: (timer: unknown) => void;
  readonly graceMs?: number;
  readonly intervalMs?: number;
  readonly setInterval?: (callback: () => void, interval: number) => unknown;
  readonly testScan?: (scan: () => void) => void;
}

export interface SessionDependencies {
  readonly broker?: RunnerCommandBroker;
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly database?: AppDatabase;
  readonly discoverModels?: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders?: OpenRouterProviderDiscoverer;
  readonly modelFactory?: AgentModelFactory;
  readonly now?: () => number;
  readonly liveness?: SessionLivenessOptions;
  readonly randomId?: IdGenerator;
  readonly realtime?: RealtimeHub;
  readonly toolSettings?: Pick<ToolSettingsStore, "read">;
  readonly workspaces?: SessionWorkspaceReader;
}

export const permissiveWorkspaceReader = {
  defaultForUser: () => undefined,
  exists: () => true,
} satisfies SessionWorkspaceReader;
