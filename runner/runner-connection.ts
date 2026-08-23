export type RunnerConnectionError = Error & {
  readonly runnerConnectionError: true;
};

export function createRunnerConnectionError(
  message: string,
  name = "RunnerConnectionError",
): RunnerConnectionError {
  return Object.assign(new Error(message), {
    name,
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
