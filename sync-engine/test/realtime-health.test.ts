import { expect, test } from "vitest";
import { createEngineHealth } from "../engine-health.ts";
import {
  configuredRealtimeTestIntegration,
  REALTIME_TEST_USER,
  realtimeTestAuth,
} from "./realtime-test-helpers.ts";
import {
  openUserRealtimeTestSocket,
  parseRealtimeMessages,
} from "./realtime-test-socket-helpers.ts";

test("sends and publishes storage-health snapshots", () => {
  const health = createEngineHealth(() => undefined);
  const realtime = configuredRealtimeTestIntegration({
    auth: realtimeTestAuth(REALTIME_TEST_USER),
    health,
  });
  const connection = openUserRealtimeTestSocket(realtime);

  health.degrade("low_disk_space", "test low space");

  expect(parseRealtimeMessages(connection.record.sent)).toContainEqual({
    health: { degraded: true, reasons: ["low_disk_space"] },
    type: "health",
  });
});
