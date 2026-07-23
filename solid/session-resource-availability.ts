import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ProviderViewState } from "./provider-client.tsx";
import type { RunnerViewState } from "./runner-client.tsx";

function providerCredentialIds(
  state: ProviderViewState,
): readonly string[] | undefined {
  return state.credentials?.map(({ id }) => id);
}

export function selectedSessionCredentialAvailable(
  detail: AgentSessionDetail | undefined,
  openAi: ProviderViewState,
  openRouter: ProviderViewState,
): boolean | undefined {
  const openAiIds = providerCredentialIds(openAi);
  const openRouterIds = providerCredentialIds(openRouter);
  if (
    detail === undefined ||
    openAiIds === undefined ||
    openRouterIds === undefined
  ) {
    return undefined;
  }
  return (detail.provider === "openai" ? openAiIds : openRouterIds).includes(
    detail.credentialId,
  );
}

export function selectedSessionRunnerAvailable(
  detail: AgentSessionDetail | undefined,
  runners: RunnerViewState,
): boolean | undefined {
  if (detail === undefined || runners.runners === undefined) {
    return undefined;
  }
  return runners.runners.some(
    ({ id, status }) => id === detail.runnerId && status === "online",
  );
}
