import { waitForSessionValue } from "./session-integration-helpers.ts";

interface DrainProgressReader {
  readonly drainProgress: () => readonly unknown[];
}

export function waitForRestartDrainCount(
  sessions: DrainProgressReader,
  expected: number,
): Promise<unknown> {
  return waitForSessionValue(
    sessions.drainProgress.bind(sessions),
    (value) => Array.isArray(value) && value.length === expected,
  );
}
