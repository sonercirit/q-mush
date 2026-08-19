import type { RestartDrainSessionProgress } from "./session-restart-control.ts";

interface RestartProgressVisibility {
  readonly sessionIds: Set<string>;
  initialized: boolean;
}

export type RestartProgressVisibilityCache = Map<
  string,
  RestartProgressVisibility
>;

function visibility(
  cache: RestartProgressVisibilityCache,
  key: string,
): RestartProgressVisibility {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const created = { initialized: false, sessionIds: new Set<string>() };
  cache.set(key, created);
  return created;
}

export function addVisibleRestartSession(
  cache: RestartProgressVisibilityCache,
  key: string,
  sessionId: string,
): void {
  visibility(cache, key).sessionIds.add(sessionId);
}

export function visibleRestartProgress(
  cache: RestartProgressVisibilityCache,
  key: string,
  listSessionIds: () => readonly string[],
  progress: (
    sessionIds: ReadonlySet<string>,
  ) => readonly RestartDrainSessionProgress[],
): readonly RestartDrainSessionProgress[] {
  const visible = visibility(cache, key);
  if (!visible.initialized) {
    for (const sessionId of listSessionIds()) visible.sessionIds.add(sessionId);
    visible.initialized = true;
  }
  return progress(visible.sessionIds);
}
