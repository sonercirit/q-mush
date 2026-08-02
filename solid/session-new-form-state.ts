import type { SessionViewState } from "./session-view-state.ts";

export type NewSessionFormState = Pick<
  SessionViewState,
  "creating" | "draft" | "modelDiscovery" | "openSelect" | "providerDiscovery"
>;
