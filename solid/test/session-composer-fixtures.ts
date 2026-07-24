import type { ProviderViewState } from "../provider-client.tsx";
import type { RunnerViewState } from "../runner-client.tsx";
import { providerViewState, runnerViewState } from "./client-state-fixtures.ts";
import { runnerSummary } from "./runner-fixtures.ts";

export interface ComposerTestResources {
  readonly emptyProvider: ProviderViewState;
  readonly openAi: ProviderViewState;
  readonly runners: RunnerViewState;
}

export function composerTestResources(): ComposerTestResources {
  return {
    emptyProvider: providerViewState([]),
    openAi: providerViewState([
      {
        accountId: "account-1",
        id: "credential-1",
        isDefault: false,
        label: "OpenAI account",
        source: "oauth",
      },
    ]),
    runners: runnerViewState([runnerSummary(1)]),
  };
}
