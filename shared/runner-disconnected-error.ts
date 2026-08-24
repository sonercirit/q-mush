const RUNNER_DISCONNECTED_ERROR = "RunnerDisconnectedError" as const;

export interface RunnerDisconnectedError extends Error {
  readonly name: typeof RUNNER_DISCONNECTED_ERROR;
}

export const createRunnerDisconnectedError = (
  message = "The runner disconnected before the command returned",
): RunnerDisconnectedError =>
  Object.assign(new Error(message), {
    name: RUNNER_DISCONNECTED_ERROR,
  });

export const isRunnerDisconnectedError = (
  value: unknown,
): value is RunnerDisconnectedError =>
  value instanceof Error && value.name === RUNNER_DISCONNECTED_ERROR;
