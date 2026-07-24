import { expect, test } from "vitest";
import {
  RealtimeHub,
  type RealtimeSocket,
} from "../../sync-engine/realtime-hub.ts";
import { RecordingSocket } from "./realtime-test-helpers.ts";

class TestSocket extends RecordingSocket {}

class FailingSocket implements RealtimeSocket {
  close(): void {
    // Already closed.
  }

  send(): number {
    throw new Error("socket closed");
  }
}

test("replaces an existing connection for the same runner", () => {
  const hub = new RealtimeHub();
  const sockets = [new TestSocket(), new TestSocket()] as const;
  const [first, second] = sockets;

  expect(hub.setRunner("runner-1", first, true)).toBeUndefined();
  expect(hub.setRunner("runner-1", second, true)).toBe(first);
  hub.publishRunnerCancellation("runner-1", "command-1");

  expect(first.messages).toEqual([]);
  expect(second.messages).toHaveLength(1);
});

test("continues publishing when one user socket is closing", () => {
  const hub = new RealtimeHub();
  const active = new TestSocket();
  const userId = "closing-user";
  hub.setUser(userId, new FailingSocket(), true);
  hub.setUser(userId, active, true);

  hub.publishUser(userId, { sessions: [], type: "sessions" });

  expect(active.messages).toEqual(['{"sessions":[],"type":"sessions"}']);
});

test("publishes snapshots only to the authenticated user's sockets", () => {
  const hub = new RealtimeHub();
  const first = new TestSocket();
  const second = new TestSocket();
  const other = new TestSocket();

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

test("delivers queued commands immediately and cancellation to a runner socket", () => {
  const hub = new RealtimeHub();
  const runner = new TestSocket();
  const command = {
    arguments: { path: "README.md" },
    id: "command-1",
    sessionId: "session-1",
    tool: "read",
    workingDirectory: "/work/project",
  };

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
