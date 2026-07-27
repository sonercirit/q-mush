import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionCommandTransport } from "./session-transport.ts";

export type SessionToolUpdateResult = Readonly<{
  warning: string | null;
  updated: boolean;
}>;

export interface SessionCommandViewOptions {
  readonly transport: SessionCommandTransport | undefined;
  readonly view: RevisionState<SessionViewState>;
}
