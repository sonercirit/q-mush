import { expect, test, vi } from "vitest";

import { visibleRestartProgress } from "../restart-progress-visibility.ts";
import type { RestartDrainSessionProgress } from "../session-restart-control.ts";

const progress = (elapsedMs: number): RestartDrainSessionProgress => ({
  elapsedMs,
  runnerId: "runner",
  sessionId: "session-visible",
  tools: [],
  totalTools: 0,
});

test("caches visibility while recomputing changing restart progress", () => {
  const cache = new Map<string, ReadonlySet<string>>();
  const listSessionIds = vi.fn(() => ["session-visible"]);
  const snapshots: readonly RestartDrainSessionProgress[][] = [
    [progress(1)],
    [progress(2)],
    [],
  ];
  let tick = 0;
  const readProgress = vi.fn((sessionIds: ReadonlySet<string>) => {
    expect([...sessionIds]).toEqual(["session-visible"]);
    return snapshots[tick++] ?? [];
  });

  expect(
    visibleRestartProgress(
      cache,
      "user\0workspace",
      listSessionIds,
      readProgress,
    ),
  ).toEqual([progress(1)]);
  expect(
    visibleRestartProgress(
      cache,
      "user\0workspace",
      listSessionIds,
      readProgress,
    ),
  ).toEqual([progress(2)]);
  expect(
    visibleRestartProgress(
      cache,
      "user\0workspace",
      listSessionIds,
      readProgress,
    ),
  ).toEqual([]);
  expect(listSessionIds).toHaveBeenCalledTimes(1);
  expect(readProgress).toHaveBeenCalledTimes(3);
});
