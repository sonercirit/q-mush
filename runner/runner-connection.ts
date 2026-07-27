export class RunnerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerConnectionError";
  }
}

export interface RunnerConnectionSettlement {
  readonly settled: boolean;
  readonly settle: (error?: RunnerConnectionError) => void;
}

export function createRunnerConnectionSettlement(
  resolve: () => void,
  reject: (error: RunnerConnectionError) => void,
): RunnerConnectionSettlement {
  let settled = false;
  return {
    get settled() {
      return settled;
    },
    settle: (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    },
  };
}
