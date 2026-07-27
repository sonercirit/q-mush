import { describe, expect, test } from "vitest";
import {
  readUserRealtimeCommand,
  SESSION_REALTIME_OPERATIONS,
  USER_REALTIME_MAX_PAYLOAD_LENGTH,
  UserRealtimeProtocolError,
} from "../../shared/user-realtime-protocol.ts";
import { utf8ByteLength } from "../../shared/utf8.ts";

const MAXIMUM_COMMAND_BYTES = 128 * 1024 * 1024;

function command(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    commandId: "command-1",
    idempotencyKey: "mutation-1",
    operation: SESSION_REALTIME_OPERATIONS.create,
    payload: { prompt: "Inspect the workspace" },
    type: "command",
    ...overrides,
  });
}

function emptyDataPayloadCapacity(): number {
  return (
    MAXIMUM_COMMAND_BYTES - utf8ByteLength(command({ payload: { data: "" } }))
  );
}

describe("authenticated user realtime protocol", () => {
  test("parses a correlated generic command envelope", () => {
    expect(
      readUserRealtimeCommand(
        command({ operation: "sessions.answer_question" }),
      ),
    ).toEqual({
      commandId: "command-1",
      idempotencyKey: "mutation-1",
      operation: "sessions.answer_question",
      payload: { prompt: "Inspect the workspace" },
      type: "command",
    });
  });

  test("rejects legacy refresh messages and malformed envelopes", () => {
    for (const message of [
      JSON.stringify({ type: "refresh" }),
      command({ commandId: "" }),
      command({ idempotencyKey: "contains spaces" }),
      command({ operation: "Sessions.CREATE" }),
      command({ payload: [] }),
      command({ unexpected: true }),
    ]) {
      expect(() => readUserRealtimeCommand(message)).toThrow(
        UserRealtimeProtocolError,
      );
    }
  });

  test("allows image-bearing commands up to the configured WebSocket limit", () => {
    const room = emptyDataPayloadCapacity();
    expect(
      readUserRealtimeCommand(command({ payload: { data: "x".repeat(room) } })),
    ).toMatchObject({ commandId: "command-1" });
    expect(() =>
      readUserRealtimeCommand(
        command({ payload: { data: "x".repeat(room + 1) } }),
      ),
    ).toThrow("too large");
    expect(USER_REALTIME_MAX_PAYLOAD_LENGTH).toBe(MAXIMUM_COMMAND_BYTES + 1);
  });

  test("measures multibyte command envelopes at the UTF-8 byte boundary", () => {
    const room = emptyDataPayloadCapacity();
    const multibyte = "é";
    const exactData = multibyte.repeat(Math.floor(room / 2));
    const exact = command({
      payload: { data: `${exactData}${room % 2 === 0 ? "" : "x"}` },
    });

    expect(utf8ByteLength(exact)).toBe(MAXIMUM_COMMAND_BYTES);
    expect(readUserRealtimeCommand(exact)).toMatchObject({
      commandId: "command-1",
    });

    const oversized = command({ payload: { data: `${exactData}é` } });
    expect(utf8ByteLength(oversized)).toBeGreaterThan(MAXIMUM_COMMAND_BYTES);
    expect(() => readUserRealtimeCommand(oversized)).toThrow("too large");
  });

  test("retains a valid command ID on a malformed command for an error ack", () => {
    try {
      readUserRealtimeCommand(command({ operation: "bad operation" }));
      throw new Error("The malformed command was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(UserRealtimeProtocolError);
      expect(
        error instanceof UserRealtimeProtocolError
          ? error.commandId
          : undefined,
      ).toBe("command-1");
    }
  });
});
