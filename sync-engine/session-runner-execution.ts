import { RunnerDisconnectedError } from "../shared/runner-command-broker.ts";

interface SessionRunnerExecution {
  readonly restartHandoffRequested: () => boolean;
}

function restartHandoffError(): DOMException {
  return new DOMException(
    "The runner disconnected during a restart handoff",
    "RestartHandoff",
  );
}

export async function executeForSession<Result>(
  runtime: SessionRunnerExecution,
  execute: () => Promise<Result>,
  handoff?: (error: DOMException) => void,
): Promise<Result> {
  try {
    return await execute();
  } catch (error) {
    if (
      error instanceof RunnerDisconnectedError &&
      runtime.restartHandoffRequested()
    ) {
      const handoffError = restartHandoffError();
      handoff?.(handoffError);
      throw handoffError;
    }
    throw error;
  }
}

export function isRestartHandoffError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "RestartHandoff";
}
