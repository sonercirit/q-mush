import type { RestartHandoffOperation } from "../shared/session-model.ts";
import type { RestartRequest } from "./session-runtime.ts";

type RestartRequestPersistence = (
  request: RestartRequest,
  durable: boolean,
) => Promise<void> | void;

export interface SessionRestartRequester {
  readonly restartRequest: (
    persist?: RestartRequestPersistence,
  ) => RestartRequest | undefined;
}

export interface DurableRestartPersistence {
  readonly clear: () => Promise<void> | void;
  readonly operation: RestartHandoffOperation;
  readonly persist: RestartRequestPersistence;
}
