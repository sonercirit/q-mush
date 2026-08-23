import { RUNNER_VERSION_HEADER } from "../shared/routes.ts";

const RUNNER_VERSION_PATTERN = /^[a-f\d]{64}$/u;

export interface RunnerUpdateTrigger {
  observe(response: Response): void;
  take(): boolean;
}

export function createRunnerUpdateTrigger(
  currentVersion: string,
): RunnerUpdateTrigger {
  if (!RUNNER_VERSION_PATTERN.test(currentVersion)) {
    throw new Error("The current runner version is invalid");
  }
  let advertisedVersion: string | undefined;
  let attemptedVersion: string | undefined;
  return {
    observe(response) {
      const version = response.headers.get(RUNNER_VERSION_HEADER);
      if (version === null || !RUNNER_VERSION_PATTERN.test(version)) return;
      advertisedVersion = version === currentVersion ? undefined : version;
    },
    take() {
      if (
        advertisedVersion === undefined ||
        advertisedVersion === attemptedVersion
      ) {
        return false;
      }
      attemptedVersion = advertisedVersion;
      return true;
    },
  };
}
