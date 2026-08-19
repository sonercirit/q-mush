import { expect, test, vi } from "vitest";

import {
  addVisibleRestartSession,
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
  addVisibleRestartSession(cache, key, "session-late");
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
  addVisibleRestartSession(cache, key, "session-late");
  const listSessionIds = vi.fn(() => sessionIds("session-initial"));
  const readProgress = vi.fn(progressForIds);

  expect(
    visibleRestartProgress(cache, key, listSessionIds, readProgress),
  ).toEqual([progress("session-late", 1), progress("session-initial", 1)]);
  expect(listSessionIds).toHaveBeenCalledOnce();
});
