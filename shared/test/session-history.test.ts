import { describe, expect, test } from "vitest";
import {
  decodeSessionHistoryCursor,
  encodeSessionHistoryCursor,
  readSessionHistoryRequest,
} from "../session-history.ts";

describe("session history cursors", () => {
  test("round trips a bounded opaque segment cursor", () => {
    const cursor = encodeSessionHistoryCursor("session-1", 3, 100);

    expect(cursor).not.toContain("session-1");
    expect(decodeSessionHistoryCursor(cursor)).toEqual({
      offset: 100,
      segment: 3,
      sessionId: "session-1",
      version: 1,
    });
  });

  test("rejects malformed cursors and payload fields", () => {
    expect(decodeSessionHistoryCursor("not+base64")).toBeUndefined();
    expect(
      readSessionHistoryRequest({ cursor: null, sessionId: "session-1" }),
    ).toEqual({ cursor: null, sessionId: "session-1" });
    expect(
      readSessionHistoryRequest({
        cursor: null,
        extra: true,
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });
});
