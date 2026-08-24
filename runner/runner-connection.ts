export type RunnerConnectionError = Error & {
  readonly kind?: string;
  readonly runnerConnectionError: true;
};

export function createRunnerConnectionError(
  message: string,
  kind?: string,
): RunnerConnectionError {
  return Object.assign(new Error(message), {
    ...(kind === undefined ? {} : { kind }),
    runnerConnectionError: true as const,
  });
}

export interface RunnerConnectionSettlement {
  readonly settled: boolean;
  readonly settle: (error?: Error) => void;
}

export function createRunnerConnectionSettlement(
  resolve: () => void,
  reject: (error: Error) => void,
): RunnerConnectionSettlement {
  let settled = false;
  return {
    get settled() {
      return settled;
    },
    settle: (error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve();
      else reject(error);
    },
  };
}
