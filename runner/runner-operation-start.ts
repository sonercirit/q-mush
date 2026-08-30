import { setTimeout } from "node:timers/promises";

import { describeError } from "../shared/error.ts";
import { synchronizeRunnerOperations } from "./runner-operation-sync.ts";
import { createRunnerOperationTransport } from "./runner-operation-transport.ts";

const MAX_RETRY_MILLISECONDS = 30_000;

export const startRunnerOperationSynchronization = (
  store: Parameters<typeof synchronizeRunnerOperations>[0],
  origin: string,
  token: string,
  options: {
    readonly delay?: (
      milliseconds: number,
      signal: AbortSignal,
    ) => Promise<void>;
    readonly log?: (message: string) => void;
  } = {},
): AbortController => {
  const controller = new AbortController();
  const delay =
    options.delay ??
    ((milliseconds, signal) => setTimeout(milliseconds, undefined, { signal }));
  const log = options.log ?? console.warn;
  void (async () => {
    const transport = createRunnerOperationTransport(origin, token);
    let retryMilliseconds = 1_000;
    while (!controller.signal.aborted) {
      try {
        await synchronizeRunnerOperations(store, transport, controller.signal);
        retryMilliseconds = 1_000;
      } catch (error) {
        if (controller.signal.aborted) return;
        log(`Operation synchronization deferred: ${describeError(error)}`);
      }
      try {
        await delay(retryMilliseconds, controller.signal);
      } catch {
        return;
      }
      retryMilliseconds = Math.min(
        MAX_RETRY_MILLISECONDS,
        retryMilliseconds * 2,
      );
    }
  })();
  return controller;
};
