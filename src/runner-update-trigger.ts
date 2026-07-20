import { RUNNER_VERSION_HEADER } from "./routes.ts";

const RUNNER_VERSION_PATTERN = /^[a-f\d]{64}$/u;

export class RunnerUpdateTrigger {
  readonly #currentVersion: string;
  #advertisedVersion: string | undefined;
  #attemptedVersion: string | undefined;

  constructor(currentVersion: string) {
    if (!RUNNER_VERSION_PATTERN.test(currentVersion)) {
      throw new Error("The current runner version is invalid");
    }

    this.#currentVersion = currentVersion;
  }

  observe(response: Response): void {
    const version = response.headers.get(RUNNER_VERSION_HEADER);

    if (version === null || !RUNNER_VERSION_PATTERN.test(version)) {
      return;
    }

    this.#advertisedVersion =
      version === this.#currentVersion ? undefined : version;
  }

  take(): boolean {
    if (
      this.#advertisedVersion === undefined ||
      this.#advertisedVersion === this.#attemptedVersion
    ) {
      return false;
    }

    this.#attemptedVersion = this.#advertisedVersion;
    return true;
  }
}
