import {
  currentPendingRunner,
  type CurrentPendingRunnerParameters,
} from "./realtime-runner-current.ts";
import type { RunnerConnection } from "./runner-store.ts";

export function withCurrentPendingRunner(
  parameters: CurrentPendingRunnerParameters,
): RunnerConnection | undefined {
  return currentPendingRunner(...parameters);
}
