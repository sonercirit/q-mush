import { expect, test } from "vitest";
import {
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { createScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  sessionDetail,
  startSessionAndCompleteAgentFile,
  waitForSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import {
  durableSessionRunnerReceipt,
  reconnectDurableSessionRunner,
} from "./session-restart-runner-continuity-helpers.ts";

test("a queued continuation launches when its existing runner reconnects after server recreation", async () => {
  const model = createScriptedAgentModel([
    { content: "Ready before restart.", toolCalls: [] },
    { content: "Continued after restart.", toolCalls: [] },
  ]);
  const initial = connectedSessionSetup(model);
  await startSessionAndCompleteAgentFile(initial);
  await waitForSessionStatus(initial, "idle");

  await initial.sessions.drain();
  const queued = await initial.sessions.realtimeCommands.messageForUser(
    TEST_AUTHENTICATED_USER,
    SESSION_ID,
    { attachments: [], images: [], prompt: "Continue after restart." },
    TEST_WORKSPACE_ID,
  );
  expect(queued.status).toBe("queued");

  const activationReceipt = durableSessionRunnerReceipt(initial);
  initial.runners.disconnected({
    id: RUNNER_ID,
    userId: TEST_USER_ID,
  });

  const recreated = connectedSessionSetup(model, "api_key", undefined, {
    database: initial.database,
  });
  expect(await sessionDetail(recreated.sessions)).toMatchObject({
    status: "queued",
  });
  reconnectDurableSessionRunner(recreated, activationReceipt);
  const afterReconnect = await sessionDetail(recreated.sessions);
  expect(afterReconnect).toMatchObject({ status: "queued" });

  await completeAgentFileLookup(recreated);
  await waitForSessionValue(
    () => sessionDetail(recreated.sessions),
    (detail) =>
      JSON.stringify(detail).includes("Continued after restart.") &&
      typeof detail === "object" &&
      detail !== null &&
      "status" in detail &&
      detail.status === "idle",
  );
  expect(model.requests.at(-1)).toContainEqual({
    content: "Continue after restart.",
    role: "user",
  });
  initial.database.$client.close();
});
