import {
  createProviderViewState,
  type ProviderCredential,
  type ProviderViewState,
} from "../../solid/provider-client.tsx";
import {
  createRunnerViewState,
  type RunnerViewState,
} from "../../solid/runner-client.tsx";

export function providerViewState(
  credentials:
    | readonly (Omit<ProviderCredential, "limits"> &
        Partial<Pick<ProviderCredential, "limits">>)[]
    | undefined,
): ProviderViewState {
  return createProviderViewState(
    credentials?.map((credential) => ({
      limits: { status: "unavailable" },
      ...credential,
    })),
  );
}

export function runnerViewState(
  runners: NonNullable<RunnerViewState["runners"]>,
): RunnerViewState {
  return createRunnerViewState(runners);
}
