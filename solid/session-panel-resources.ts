import type { Accessor } from "solid-js";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { ProviderViewState } from "./provider-credential-model.ts";
import type { RunnerViewState } from "./runner-client.tsx";

export interface SessionPanelResources {
  readonly generic?: Accessor<ProviderViewState>;
  readonly openAi: Accessor<ProviderViewState>;
  readonly openRouter: Accessor<ProviderViewState>;
  readonly runners: Accessor<RunnerViewState>;
  readonly toolSettings?: Accessor<ToolSettings | undefined>;
}
