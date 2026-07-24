import { expect, test } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { executeSessionRealtimeCommand } from "../../sync-engine/session-realtime-commands.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import { userRealtimeCommand } from "./realtime-command-fixtures.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  CREDENTIAL_ID,
  RUNNER_ID,
} from "./session-integration-fixtures.ts";

const USER: AuthenticatedUser = {
  email: "mushroom@example.com",
  id: "018bcfe5-6800-7000-8000-000000000021",
  name: "Mush Room",
};

function setup(model: AgentModel = new ScriptedAgentModel([])) {
  return connectedSessionSetup(model);
}

test("creates a session with images through the realtime command executor", async () => {
  const integration = setup();
  const result = await executeSessionRealtimeCommand(
    integration.sessions,
    USER,
    userRealtimeCommand(SESSION_REALTIME_OPERATIONS.create, {
      credentialId: CREDENTIAL_ID,
      images: [TEST_AGENT_IMAGE],
      model: "gpt-4.1-mini",
      prompt: "Inspect the screenshot",
      provider: "openai",
      reasoningEffort: "high",
      runnerId: RUNNER_ID,
      tools: ["read"],
      workingDirectory: "/work/project",
    }),
  );

  expect(result).toMatchObject({
    messages: [{ images: [TEST_AGENT_IMAGE], role: "user" }],
    status: "queued",
  });
  integration.database.$client.close();
});

test("enforces ownership for read and mutations", async () => {
  const integration = setup();
  const otherUser = { ...USER, id: "other-user" };
  const expectNotFound = async (operation: string): Promise<void> => {
    await expect(
      executeSessionRealtimeCommand(
        integration.sessions,
        otherUser,
        userRealtimeCommand(operation, { sessionId: "missing" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  };
  await expectNotFound(SESSION_REALTIME_OPERATIONS.read);
  await expectNotFound(SESSION_REALTIME_OPERATIONS.stop);
  integration.database.$client.close();
});
