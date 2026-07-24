import { expect, test } from "vitest";
import {
  appendCompactionPreviewText,
  COMPACTION_QUEUE_MAX_OPERATIONS,
  type SessionCompactionRealtimeEvent,
} from "../../shared/compaction-realtime.ts";
import {
  compactionEvents,
  realtimeCompactionTestRig,
} from "./realtime-compaction-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const PREVIEW_LIMIT = 131_072;

const BASE = {
  attempt: 0,
  operationId: "operation-1",
  sessionId: TEST_SESSION_DETAIL.id,
  type: "session_compaction",
} as const;

interface DeltaOptions {
  readonly operationId?: string;
  readonly reasoning: string;
  readonly sequence: number;
  readonly summary: string;
}

function compactionDelta(
  options: DeltaOptions,
): SessionCompactionRealtimeEvent {
  return {
    ...BASE,
    operationId: options.operationId ?? BASE.operationId,
    phase: "delta",
    reasoning: options.reasoning,
    sequence: options.sequence,
    summary: options.summary,
  };
}

function receiveCompactionDelta(
  socket: { receive(event: unknown): void },
  options: DeltaOptions,
): void {
  socket.receive(compactionDelta(options));
}

test("coalesces compaction deltas per frame and flushes lifecycle ordering", () => {
  const { events, frames, socket } = realtimeCompactionTestRig();
  const sendDelta = (options: DeltaOptions): void => {
    receiveCompactionDelta(socket, options);
  };
  socket.receive({ ...BASE, phase: "start", sequence: 0 });
  sendDelta({ reasoning: "Think", sequence: 1, summary: "Sum" });
  sendDelta({ reasoning: " again", sequence: 2, summary: "mary" });

  expect(events).toHaveLength(1);
  expect(frames).toHaveLength(1);
  frames[0]?.();
  const latest = events.at(-1);
  expect(latest).toEqual(
    expect.objectContaining({
      phase: "delta",
      reasoning: "Think again",
      sequence: 2,
      summary: "Summary",
    }),
  );

  socket.receive({
    ...BASE,
    attempt: 1,
    phase: "reset",
    sequence: 3,
  });
  expect(events.at(-1)?.type).toBe("session_compaction");
  expect(events.at(-1)).toMatchObject({ attempt: 1, phase: "reset" });
});

test("bounds concatenated compaction deltas within one frame", () => {
  const { events, frames, socket } = realtimeCompactionTestRig();
  const chunk = "x".repeat(16_384);
  for (let sequence = 1; sequence <= 9; sequence += 1) {
    receiveCompactionDelta(socket, {
      reasoning: chunk,
      sequence,
      summary: chunk,
    });
  }
  frames[0]?.();

  const delta = compactionEvents(events).at(-1);
  if (delta?.phase !== "delta") {
    throw new Error("The bounded delta was not emitted");
  }
  const expected = appendCompactionPreviewText("", chunk.repeat(9));
  expect(expected.text).toHaveLength(PREVIEW_LIMIT);
  expect(delta.reasoning).toBe(expected.text);
  expect(delta.summary).toBe(expected.text);
});

test("bounds pending compaction operations to the newest work", () => {
  const { events, frames, socket } = realtimeCompactionTestRig();
  for (let index = 0; index < COMPACTION_QUEUE_MAX_OPERATIONS + 3; index += 1) {
    const delta: SessionCompactionRealtimeEvent = {
      ...BASE,
      operationId: `operation-${String(index)}`,
      phase: "delta",
      reasoning: "r",
      sequence: 1,
      sessionId: `session-${String(index)}`,
      summary: "s",
    };
    socket.receive(delta);
  }
  frames[0]?.();

  const deltas = compactionEvents(events).filter(
    ({ phase }) => phase === "delta",
  );
  expect(deltas).toHaveLength(COMPACTION_QUEUE_MAX_OPERATIONS);
  expect(deltas[0]?.sessionId).toBe("session-3");
});

test("a session snapshot preserves active compaction work", () => {
  let snapshots = 0;
  const { events, socket } = realtimeCompactionTestRig(() => {
    snapshots += 1;
  });
  const snapshotDelta = compactionDelta({
    reasoning: "pending",
    sequence: 1,
    summary: "pending",
  });
  socket.receive({ ...BASE, phase: "start", sequence: 0 });
  socket.receive(snapshotDelta);
  socket.receive({ session: TEST_SESSION_DETAIL, type: "session" });

  expect(snapshots).toBe(0);
  const delivered = compactionEvents(events).at(-1);
  expect(delivered).toEqual(
    expect.objectContaining({
      phase: "delta",
      reasoning: "pending",
      summary: "pending",
    }),
  );
});

test("disconnect and stop discard pending compaction work", () => {
  let resets = 0;
  const { connection, events, frames, socket } = realtimeCompactionTestRig(
    () => {
      resets += 1;
    },
  );
  receiveCompactionDelta(socket, {
    operationId: "operation-2",
    reasoning: "disconnected",
    sequence: 1,
    summary: "disconnected",
  });
  socket.close();
  frames[0]?.();
  expect(compactionEvents(events)).toHaveLength(0);
  expect(resets).toBe(1);

  const beforeStop = compactionEvents(events).length;
  receiveCompactionDelta(socket, {
    operationId: "operation-3",
    reasoning: "discarded",
    sequence: 1,
    summary: "discarded",
  });
  connection.stop();
  frames[1]?.();
  expect(compactionEvents(events)).toHaveLength(beforeStop);
});
