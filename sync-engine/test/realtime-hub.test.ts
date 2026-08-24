import { expect, test } from "vitest";
import { testRunnerCommand } from "../../shared/test/runner-command-fixtures.ts";
import {
  RealtimeHub,
  type RealtimeSocket,
} from "../../sync-engine/realtime-hub.ts";
import { createRecordingRealtimeSocket } from "./realtime-hub-test-helpers.ts";

function createFailingSocket(): RealtimeSocket {
  return {
    close(): void {
      // Already closed.
    },
    send(): number {
      throw new Error("socket closed");
    },
  };
}

test("replaces an existing connection for the same runner", () => {
  const hub = new RealtimeHub();
  const sockets = [
    createRecordingRealtimeSocket(),
    createRecordingRealtimeSocket(),
  ] as const;
  const [first, second] = sockets;

  expect(hub.setRunner("runner-1", first, true)).toBeUndefined();
  expect(hub.setRunner("runner-1", second, true)).toBe(first);
  hub.publishRunnerCancellation("runner-1", "command-1");

  expect(first.messages).toEqual([]);
  expect(second.messages).toHaveLength(1);
});

test("continues publishing when one user socket is closing", () => {
  const hub = new RealtimeHub();
  const active = createRecordingRealtimeSocket();
  const userId = "closing-user";
  hub.setUser(userId, createFailingSocket(), true);
  hub.setUser(userId, active, true);

  hub.publishUser(userId, { sessions: [], type: "sessions" });

  expect(active.messages).toEqual(['{"sessions":[],"type":"sessions"}']);
});

test("publishes snapshots only to the authenticated user's sockets", () => {
  const hub = new RealtimeHub();
  const first = createRecordingRealtimeSocket();
  const second = createRecordingRealtimeSocket();
  const other = createRecordingRealtimeSocket();

  hub.setUser("user-1", first, true);
  hub.setUser("user-1", second, true);
  hub.setUser("user-2", other, true);
  hub.publishUser("user-1", { runners: [{ id: "runner-1" }], type: "runners" });

  expect(first.messages).toEqual([
    '{"runners":[{"id":"runner-1"}],"type":"runners"}',
  ]);
  expect(second.messages).toEqual(first.messages);
  expect(other.messages).toEqual([]);

  hub.setUser("user-1", first, false);
  hub.publishUser("user-1", { sessions: [], type: "sessions" });
  expect(first.messages).toHaveLength(1);
  expect(second.messages).toHaveLength(2);
});

test("publishes user-wide settings to every owned workspace without cross-user leakage", () => {
  const hub = new RealtimeHub();
  const firstWorkspace = createRecordingRealtimeSocket();
  const secondWorkspace = createRecordingRealtimeSocket();
  const global = createRecordingRealtimeSocket();
  const otherUser = createRecordingRealtimeSocket();
  hub.setUser("user-1", firstWorkspace, true, "workspace-1");
  hub.setUser("user-1", secondWorkspace, true, "workspace-2");
  hub.setUser("user-1", global, true);
  hub.setUser("user-2", otherUser, true, "workspace-1");

  hub.publishUserAllWorkspaces("user-1", {
    settings: { executionLimitMinutes: 7, outputLimitCharacters: 12_345 },
    type: "tool_settings",
  });

  const expected = [
    '{"settings":{"executionLimitMinutes":7,"outputLimitCharacters":12345},"type":"tool_settings"}',
  ];
  expect(firstWorkspace.messages).toEqual(expected);
  expect(secondWorkspace.messages).toEqual(expected);
  expect(global.messages).toEqual(expected);
  expect(otherUser.messages).toEqual([]);
});

test("delivers queued commands immediately and cancellation to a runner socket", () => {
  const hub = new RealtimeHub();

  const runner = createRecordingRealtimeSocket();
  const command = testRunnerCommand();

  expect(hub.publishRunnerCommand("runner-1", command)).toBe(false);
  hub.setRunner("runner-1", runner, true);
  expect(hub.publishRunnerCommand("runner-1", command)).toBe(true);
  hub.publishRunnerCancellation("runner-1", "command-1");

  const parsed = runner.messages.map((message): unknown => JSON.parse(message));
  expect(parsed).toEqual([
    { command, type: "command" },
    { commandId: "command-1", type: "cancel" },
  ]);
});
