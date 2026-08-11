import type { ProviderViewState } from "../provider-credential-model.ts";
import type { RunnerViewState } from "../runner-client.tsx";
import type { SessionViewState } from "../session-client.tsx";
import { renderSolidToString } from "./render-solid.tsx";
import { sessionPanelTestView } from "./session-panel-test-view.tsx";

export interface SessionPanelTestResources {
  readonly openAi: ProviderViewState;
  readonly openRouter: ProviderViewState;
  readonly runners: RunnerViewState;
}

export function renderSessionPanel(
  state: SessionViewState,
  resources: SessionPanelTestResources,
): string {
  return renderSolidToString(() =>
    sessionPanelTestView({
      openAi: () => resources.openAi,
      openRouter: () => resources.openRouter,
      runners: () => resources.runners,
      state,
    }),
  );
}
