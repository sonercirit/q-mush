import { setTimeout } from "node:timers/promises";

import { describeError } from "../shared/error.ts";
import { synchronizeRunnerOperations } from "./runner-operation-sync.ts";
import { createRunnerOperationTransport } from "./runner-operation-transport.ts";

const OPERATION_SYNC_POLL_MILLISECONDS = 5_000;
const OPERATION_SYNC_BACKOFF_BASE_MILLISECONDS = 1_000;
const OPERATION_SYNC_BACKOFF_CAP_MILLISECONDS = 30_000;
const OPERATION_SYNC_JITTER_RATIO = 0.2;

const jittered = (milliseconds: number, random: () => number): number =>
  Math.round(
    milliseconds *
      (1 -
        OPERATION_SYNC_JITTER_RATIO +
        random() * OPERATION_SYNC_JITTER_RATIO * 2),
  );

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
    readonly random?: () => number;
  } = {},
): AbortController => {
  const controller = new AbortController();
  const delay =
    options.delay ??
    (async (milliseconds, signal) => {
      await setTimeout(milliseconds, undefined, { signal });
    });
  const log = options.log ?? console.warn;
  const random = options.random ?? Math.random;
  void (async () => {
    const transport = createRunnerOperationTransport(origin, token);
    let backoffMilliseconds = OPERATION_SYNC_BACKOFF_BASE_MILLISECONDS;
    while (!controller.signal.aborted) {
      let successful = false;
      try {
        await synchronizeRunnerOperations(store, transport, controller.signal);
        successful = true;
        backoffMilliseconds = OPERATION_SYNC_BACKOFF_BASE_MILLISECONDS;
      } catch (error) {
        log(`Operation synchronization deferred: ${describeError(error)}`);
      }
      const interval = successful
        ? OPERATION_SYNC_POLL_MILLISECONDS
        : backoffMilliseconds;
      try {
        await delay(jittered(interval, random), controller.signal);
      } catch {
        return;
      }
      if (!successful)
        backoffMilliseconds = Math.min(
          OPERATION_SYNC_BACKOFF_CAP_MILLISECONDS,
          backoffMilliseconds * 2,
        );
    }
  })();
  return controller;
};
