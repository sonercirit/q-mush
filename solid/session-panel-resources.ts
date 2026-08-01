import type { Accessor } from "solid-js";
import type { ProviderViewState } from "./provider-client.tsx";
import type { RunnerViewState } from "./runner-client.tsx";

export interface SessionPanelResources {
  readonly generic?: Accessor<ProviderViewState>;
  readonly openAi: Accessor<ProviderViewState>;
  readonly openRouter: Accessor<ProviderViewState>;
  readonly runners: Accessor<RunnerViewState>;
}
