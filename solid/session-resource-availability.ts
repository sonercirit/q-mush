import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ProviderViewState } from "./provider-client.tsx";
import type { RunnerViewState } from "./runner-client.tsx";

export function selectedSessionCredentialAvailable(
  detail: AgentSessionDetail | undefined,
  openAi: ProviderViewState,
  openRouter: ProviderViewState,
): boolean | undefined {
  if (detail === undefined) {
    return undefined;
  }
  const provider = detail.provider === "openai" ? openAi : openRouter;
  if (provider.credentials !== undefined) {
    return provider.credentials.some(({ id }) => id === detail.credentialId);
  }
  return provider.error === undefined ? undefined : false;
}

export function selectedSessionRunnerAvailable(
  detail: AgentSessionDetail | undefined,
  runners: RunnerViewState,
): boolean | undefined {
  if (detail === undefined) {
    return undefined;
  }
  if (runners.runners !== undefined) {
    return runners.runners.some(
      ({ id, status }) => id === detail.runnerId && status === "online",
    );
  }
  return runners.error === undefined ? undefined : false;
}
