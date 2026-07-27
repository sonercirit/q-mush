import type { RestartRequest } from "./session-runtime.ts";

export interface SessionRestartRequester {
  readonly restartRequest: (
    persist?: (request: RestartRequest) => void,
  ) => RestartRequest | undefined;
}
