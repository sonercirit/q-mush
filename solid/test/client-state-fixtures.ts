import {
  createProviderViewState,
  type ProviderViewState,
} from "../../solid/provider-credential-model.ts";
import {
  createRunnerViewState,
  type RunnerViewState,
} from "../../solid/runner-client.tsx";

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
