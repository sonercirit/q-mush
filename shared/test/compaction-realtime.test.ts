import { describe, expect, test } from "vitest";
import {
  appendCompactionPreviewText,
  readSessionCompactionRealtimeEvent,
  splitCompactionRealtimeDelta,
} from "../../shared/compaction-realtime.ts";

const DELTA_LIMIT = 16_384;
const PREVIEW_LIMIT = 131_072;

function read(payload: Readonly<Record<string, unknown>>) {
  return readSessionCompactionRealtimeEvent(payload);
}

const BASE_EVENT = {
  attempt: 0,
  operationId: "session-1:7bd607f0-df72-4f35-a7a9-f3903d7a80e1",
  sequence: 0,
  sessionId: "session-1",
  type: "session_compaction",
} as const;

describe("compaction realtime protocol", () => {
  test("decodes every bounded lifecycle phase", () => {
    const start = read({ ...BASE_EVENT, phase: "start" });
    const reset = read({
      ...BASE_EVENT,
      attempt: 1,
      phase: "reset",
      sequence: 1,
    });
    expect([start.phase, reset.phase, reset.attempt, reset.sequence]).toEqual([
      "start",
      "reset",
      1,
      1,
    ]);
    const delta = read({
      ...BASE_EVENT,
      phase: "delta",
      reasoning: "Checking constraints",
      sequence: 2,
      summary: "Keep the focused changes",
    });
    expect(delta).toMatchObject({
      phase: "delta",
      reasoning: "Checking constraints",
      sequence: 2,
      summary: "Keep the focused changes",
    });

    for (const phase of ["complete", "cancel", "failure"] as const) {
      expect(read({ ...BASE_EVENT, phase, sequence: 3 })).toEqual({
        ...BASE_EVENT,
        phase,
        sequence: 3,
      });
    }
  });

  test("rejects invalid identifiers, ordering fields, phases, and delta bounds", () => {
    const emptyDelta = Object.assign({}, BASE_EVENT, {
      phase: "delta",
      reasoning: "",
      sequence: 1,
      summary: "",
    });
    const oversizedDelta = Object.assign({}, emptyDelta, {
      summary: "x".repeat(DELTA_LIMIT + 1),
    });
    for (const payload of [
      { ...BASE_EVENT, operationId: "", phase: "start" },
      { ...BASE_EVENT, attempt: -1, phase: "start" },
      { ...BASE_EVENT, phase: "start", sequence: 1 },
      { ...BASE_EVENT, attempt: 0, phase: "reset", sequence: 1 },
      emptyDelta,
      oversizedDelta,
      { ...BASE_EVENT, phase: "unknown" },
    ]) {
      expect(() => read(payload)).toThrow("compaction realtime event");
    }
  });

  test("splits outbound text within codec limits", () => {
    const text = "x".repeat(DELTA_LIMIT * 2 + 1);
    const chunks = splitCompactionRealtimeDelta(text, text);

    expect(chunks.map(({ summary }) => summary.length)).toEqual([
      DELTA_LIMIT,
      DELTA_LIMIT,
      1,
    ]);
    expect(chunks.map(({ reasoning }) => reasoning.length)).toEqual([
      DELTA_LIMIT,
      DELTA_LIMIT,
      1,
    ]);
  });

  test("bounds temporary preview text and remembers truncation", () => {
    const nearlyFull = "a".repeat(PREVIEW_LIMIT - 2);
    const appended = appendCompactionPreviewText(nearlyFull, "bcdef");

    expect(appended.text).toHaveLength(PREVIEW_LIMIT);
    expect(appended.text.endsWith("bc")).toBe(true);
    expect(appended.truncated).toBe(true);
    expect(
      appendCompactionPreviewText(appended.text, "ignored", appended.truncated),
    ).toEqual(appended);
  });

  test("does not continue appending after the preview is full", () => {
    const full = "x".repeat(PREVIEW_LIMIT);
    const appended = appendCompactionPreviewText(full, "more");

    expect(appended).toEqual({ text: full, truncated: true });
  });
});
