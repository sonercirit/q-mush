import { createProviderViewState } from "../provider-credential-model.ts";
import { createRunnerViewState } from "../runner-client.tsx";
import type { SessionController } from "../session-controller.ts";
import { runnerSummary } from "./runner-fixtures.ts";

export function sessionPanelResourceProps(controller: SessionController) {
  return {
    controller,
    openAi: () => createProviderViewState([]),
    openRouter: () => createProviderViewState([]),
    runners: () => createRunnerViewState([runnerSummary(1)]),
  };
}
