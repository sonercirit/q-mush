import { expect, test, vi } from "vitest";

import {
  registerRestartProgressVisibilityListener,
  type RestartProgressVisibilityCache,
  visibleRestartProgress,
} from "../restart-progress-visibility.ts";
import type { RestartDrainSessionProgress } from "../session-restart-control.ts";

function progress(
  sessionId: string,
  elapsedMs: number,
): RestartDrainSessionProgress {
  return {
    elapsedMs,
    runnerId: "runner",
    sessionId,
    tools: [],
    totalTools: 0,
  };
}

function sessionIds(...ids: string[]): string[] {
  return ids;
}

function progressForIds(sessionIds: ReadonlySet<string>) {
  return [...sessionIds].map((sessionId) => progress(sessionId, 1));
}

function visibilityCache(): RestartProgressVisibilityCache {
  return new Map();
}

type ChangeListener = (userId: string, sessionIds: readonly string[]) => void;

function visibilityListener(
  cache: RestartProgressVisibilityCache,
  workspaceId: string,
  detailIsVisible: (sessionId: string) => boolean = () => true,
): ChangeListener {
  let listener: ChangeListener | undefined;
  registerRestartProgressVisibilityListener({
    cache,
    detailIsVisible: (_userId, sessionId) => detailIsVisible(sessionId),
    isRestarting: () => true,
    subscribe: (registered) => {
      listener = registered;
    },
    userWorkspaces: () => [workspaceId],
  });
  if (listener === undefined) throw new Error("listener was not registered");
  return listener;
}

function addSession(
  cache: RestartProgressVisibilityCache,
  key: string,
  sessionId: string,
): void {
  const [userId = "", workspaceId = ""] = key.split("\0");
  visibilityListener(cache, workspaceId)(userId, [sessionId]);
}

test("does not register visible sessions outside a restart", () => {
  const cache = visibilityCache();
  const listeners: ChangeListener[] = [];
  registerRestartProgressVisibilityListener({
    cache,
    detailIsVisible: () => true,
    isRestarting: () => false,
    subscribe: (registered) => {
      listeners.push(registered);
    },
    userWorkspaces: () => ["workspace"],
  });
  const listener = listeners[0];
  if (listener === undefined) throw new Error("listener was not registered");

  listener("user", ["session-one", "session-two"]);

  expect(cache).toEqual(new Map());
});

test("registers every visible session in a batched restart change", () => {
  const cache = visibilityCache();
  const listener = visibilityListener(
    cache,
    "workspace",
    (sessionId) => sessionId !== "hidden",
  );

  listener("user", ["session-one", "hidden", "session-two"]);

  expect(
    visibleRestartProgress(cache, "user\0workspace", () => [], progressForIds),
  ).toEqual([progress("session-one", 1), progress("session-two", 1)]);
});

test("publishes late visible drain progress without repeating the listing", () => {
  const cache = visibilityCache();
  const key = "user\0workspace";
  const otherKey = "other-user\0other-workspace";
  const listSessionIds = vi.fn(() => sessionIds("session-initial"));
  const listOtherSessionIds = vi.fn(() => sessionIds("session-other"));
  const draining = new Map([
    ["session-initial", progress("session-initial", 1)],
  ]);
  const browserPublications: RestartDrainSessionProgress[][] = [];
  const readProgress = vi.fn((sessionIds: ReadonlySet<string>) =>
    [...sessionIds].flatMap((sessionId) => {
      const current = draining.get(sessionId);
      return current === undefined ? [] : [current];
    }),
  );
  const publish = () => {
    browserPublications.push([
      ...visibleRestartProgress(cache, key, listSessionIds, readProgress),
    ]);
  };

  publish();
  draining.set("session-other", progress("session-other", 3));
  expect(
    visibleRestartProgress(cache, otherKey, listOtherSessionIds, readProgress),
  ).toEqual([progress("session-other", 3)]);
  draining.set("session-late", progress("session-late", 2));
  addSession(cache, key, "session-late");
  publish();

  expect(browserPublications).toEqual([
    [progress("session-initial", 1)],
    [progress("session-initial", 1), progress("session-late", 2)],
  ]);
  expect(listSessionIds).toHaveBeenCalledTimes(1);
  expect(listOtherSessionIds).toHaveBeenCalledOnce();
  expect(readProgress).toHaveBeenCalledTimes(3);
});

test("keeps a session added before the initial visibility listing", () => {
  const cache = visibilityCache();
  const key = "user\0workspace";
  addSession(cache, key, "session-late");
  const listSessionIds = vi.fn(() => sessionIds("session-initial"));
  const readProgress = vi.fn(progressForIds);

  expect(
    visibleRestartProgress(cache, key, listSessionIds, readProgress),
  ).toEqual([progress("session-late", 1), progress("session-initial", 1)]);
  expect(listSessionIds).toHaveBeenCalledOnce();
});
