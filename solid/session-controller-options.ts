import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionLoadController } from "./session-controller-load.ts";
import type { SessionReconciliationController } from "./session-controller-reconciliation.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export type SessionToolUpdateResult = Readonly<{
  warning: string | null;
  updated: boolean;
}>;

export interface SessionCommandViewOptions {
  readonly transport: SessionCommandTransport | undefined;
  readonly view: RevisionState<SessionViewState>;
}

export interface SessionCreationViewOptions extends SessionCommandViewOptions {
  readonly loader: SessionLoadController;
  readonly reconciliation: SessionReconciliationController;
}
