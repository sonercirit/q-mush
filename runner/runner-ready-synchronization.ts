import type { startRunnerOperationSynchronization } from "./runner-operation-start.ts";

interface ReadySynchronizationOptions {
  readonly origin: string;
  readonly start: typeof startRunnerOperationSynchronization;
  readonly store: Parameters<typeof startRunnerOperationSynchronization>[0];
  readonly token: string;
}

export const createRunnerReadySynchronization = (
  options: ReadySynchronizationOptions,
) => {
  let active: AbortController | undefined;
  return {
    disconnected() {
      active?.abort();
      active = undefined;
    },
    ready() {
      active?.abort();
      active = options.start(options.store, options.origin, options.token);
    },
  };
};
