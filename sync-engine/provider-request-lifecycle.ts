import type { AgentModelRequestOptions } from "./agent-model-options.ts";

type ProviderRequestStateHandler = NonNullable<
  AgentModelRequestOptions["onRequestState"]
>;

export type ProviderRequestLifecycleOptions = Pick<
  AgentModelRequestOptions,
  "onDelta" | "onRequestState"
>;

const IGNORE_PROVIDER_REQUEST_STATE: ProviderRequestStateHandler = () =>
  undefined;

export function providerRequestStateHandler(
  handler: AgentModelRequestOptions["onRequestState"],
): ProviderRequestStateHandler {
  return handler ?? IGNORE_PROVIDER_REQUEST_STATE;
}
