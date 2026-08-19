import type { RestartDrainSessionProgress } from "./session-restart-control.ts";

export function visibleRestartProgress(
  cache: Map<string, ReadonlySet<string>>,
  key: string,
  listSessionIds: () => readonly string[],
  progress: (
    sessionIds: ReadonlySet<string>,
  ) => readonly RestartDrainSessionProgress[],
): readonly RestartDrainSessionProgress[] {
  let sessionIds = cache.get(key);
  if (sessionIds === undefined) {
    sessionIds = new Set(listSessionIds());
    cache.set(key, sessionIds);
  }
  return progress(sessionIds);
}
