import { expect, test } from "vitest";
import { createRealtimeHub } from "../realtime-hub.ts";
import { createSessionsChangedPublisher } from "../session-credential-reassignment-realtime.ts";
import { createRecordingRealtimeSocket } from "./realtime-hub-test-helpers.ts";

test("credential reassignment publishes one non-sensitive aggregate event", () => {
  const hub = createRealtimeHub();
  const [socket, other] = [
    createRecordingRealtimeSocket(),
    createRecordingRealtimeSocket(),
  ];
  hub.setUser("user-1", socket, true);
  hub.setUser("user-2", other, true);

  createSessionsChangedPublisher(hub)("user-1");

  expect(socket.messages).toEqual(['{"type":"sessions_changed"}']);
  expect(other.messages).toEqual([]);
  expect(socket.messages[0]).not.toContain("credential");
  expect(socket.messages[0]).not.toContain("sessionId");
});
