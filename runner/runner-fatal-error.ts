import { describeError } from "../shared/error.ts";

export function reportRunnerFatalError(error: unknown): void {
  console.error(`Q Mush runner stopped: ${describeError(error)}`);
  process.exitCode = 1;
}
