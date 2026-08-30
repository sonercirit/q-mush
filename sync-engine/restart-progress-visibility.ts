import type { RestartDrainSessionProgress } from "./session-restart-control.ts";

interface RestartProgressVisibility {
  readonly sessionIds: Set<string>;
  initialized: boolean;
}

export type RestartProgressVisibilityCache = Map<
  string,
  RestartProgressVisibility
>;

interface RestartVisibilityListenerOptions {
  readonly cache: RestartProgressVisibilityCache;
  readonly detailIsVisible: (
    userId: string,
    sessionId: string,
    workspaceId: string,
  ) => boolean;
  readonly isRestarting: () => boolean;
  readonly subscribe: (
    callback: (userId: string, sessionIds: readonly string[]) => void,
  ) => void;
  readonly userWorkspaces: (userId: string) => readonly string[];
}

export function registerRestartProgressVisibilityListener(
  options: RestartVisibilityListenerOptions,
): void {
  options.subscribe((userId, sessionIds) => {
    if (!options.isRestarting()) return;
    for (const workspaceId of options.userWorkspaces(userId)) {
      for (const sessionId of sessionIds) {
        if (!options.detailIsVisible(userId, sessionId, workspaceId)) continue;
        addVisibleRestartSession(
          options.cache,
          restartProgressVisibilityKey(userId, workspaceId),
          sessionId,
        );
      }
    }
  });
}

export function restartProgressVisibilityKey(
  userId: string,
  workspaceId: string,
): string {
  return `${userId}\0${workspaceId}`;
}

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

function addVisibleRestartSession(
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
