import { expect, test } from "vitest";
import { ToolSyncTracker } from "../realtime-client-tool-sync.ts";

function request(session: number, stream: number) {
  return { sessionId: `s-${String(session)}`, streamId: `t-${String(stream)}` };
}

function fill(
  tracker: ToolSyncTracker,
  sessions: number,
  streams: number,
): void {
  for (let session = 0; session < sessions; session += 1) {
    for (let stream = 0; stream < streams; stream += 1) {
      tracker.remember(request(session, stream));
    }
  }
}

test("bounds unresolved synchronization per session", () => {
  const tracker = new ToolSyncTracker();
  fill(tracker, 1, 101);
  expect(tracker.pending()).toHaveLength(100);
  expect(tracker.pending().at(0)).toEqual(request(0, 1));
});

test("bounds unresolved synchronization per user", () => {
  const tracker = new ToolSyncTracker();
  fill(tracker, 11, 100);
  expect(tracker.pending()).toHaveLength(1_000);
  expect(tracker.pending().at(-1)).toEqual(request(10, 99));
});

test("resolves streams and completed sessions", () => {
  const tracker = new ToolSyncTracker();
  fill(tracker, 1, 2);
  tracker.resolve(request(0, 0));
  expect(tracker.pending()).toEqual([request(0, 1)]);
  tracker.resolveSession("s-0");
  expect(tracker.pending()).toHaveLength(0);
});
