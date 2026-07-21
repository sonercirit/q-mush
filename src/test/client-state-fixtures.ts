import {
  createProviderViewState,
  type ProviderViewState,
} from "../provider-client.tsx";
import {
  createRunnerViewState,
  type RunnerViewState,
} from "../runner-client.tsx";

export function providerViewState(
  credentials: ProviderViewState["credentials"],
): ProviderViewState {
  return createProviderViewState(credentials);
}

export function runnerViewState(
  runners: NonNullable<RunnerViewState["runners"]>,
): RunnerViewState {
  return createRunnerViewState(runners);
}
