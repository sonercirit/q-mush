import type { AgentModelRequestOptions } from "./agent-model-options.ts";

export type ProviderRequestLifecycleOptions = Pick<
  AgentModelRequestOptions,
  "onDelta" | "onRequestState"
>;
