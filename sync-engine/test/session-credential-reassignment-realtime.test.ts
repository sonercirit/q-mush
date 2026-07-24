import { expect, test } from "vitest";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import { createSessionsChangedPublisher } from "../../sync-engine/session-credential-reassignment-realtime.ts";
import { createRecordingSocket } from "./realtime-test-helpers.ts";

test("credential reassignment publishes one non-sensitive aggregate event", () => {
  const hub = new RealtimeHub();
  const socket = createRecordingSocket();
  hub.setUser("user-1", socket, true);

  createSessionsChangedPublisher(hub)("user-1");

  expect(socket.messages).toEqual(['{"type":"sessions_changed"}']);
  expect(socket.messages[0]).not.toContain("credential");
  expect(socket.messages[0]).not.toContain("sessionId");
});
