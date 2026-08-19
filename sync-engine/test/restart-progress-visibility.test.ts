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

test("publishes late visible drain progress without repeating the listing", () => {
  const cache: RestartProgressVisibilityCache = new Map();
  const key = "user\0workspace";
  const listSessionIds = vi.fn(() => ["session-initial"]);
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
  draining.set("session-late", progress("session-late", 2));
  addVisibleRestartSession(cache, key, "session-late");
  publish();

  expect(browserPublications).toEqual([
    [progress("session-initial", 1)],
    [progress("session-initial", 1), progress("session-late", 2)],
  ]);
  expect(listSessionIds).toHaveBeenCalledTimes(1);
  expect(readProgress).toHaveBeenCalledTimes(2);
});

test("keeps a session added before the initial visibility listing", () => {
  const cache: RestartProgressVisibilityCache = new Map();
  const key = "user\0workspace";
  addVisibleRestartSession(cache, key, "session-late");
  const listSessionIds = vi.fn(() => ["session-initial"]);
  const readProgress = vi.fn((sessionIds: ReadonlySet<string>) =>
    [...sessionIds].map((sessionId) => progress(sessionId, 1)),
  );

  expect(
    visibleRestartProgress(cache, key, listSessionIds, readProgress),
  ).toEqual([progress("session-late", 1), progress("session-initial", 1)]);
  expect(listSessionIds).toHaveBeenCalledOnce();
});
