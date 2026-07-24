import { describe, expect, test } from "vitest";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_COMMAND_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  completeRunnerCommand,
  expectRunnerCommand,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

describe("session continuation", () => {
  test("spawns a session, executes tools on its runner, and accepts follow-ups", async () => {
    const model = new ScriptedAgentModel([
      {
        content: "Reading the file.",
        contextTokens: 12_345,
        thinking: "I need to inspect README before answering.",
        toolCalls: [
          {
            arguments: '{"path":"README.md"}',
            id: "model-tool-1",
            name: "read",
          },
        ],
      },
      { content: "README inspected.", contextTokens: 13_000, toolCalls: [] },
      { content: "Follow-up complete.", contextTokens: 14_000, toolCalls: [] },
      {
        content: "Continuation complete.",
        contextTokens: 15_000,
        toolCalls: [],
      },
    ]);
    const setup = connectedSessionSetup(model);
    const { database, selectedReasoningEfforts, sessions } = setup;
    const createResponse = await sessions.collection(createSessionRequest());

    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toMatchObject({
      currentContextTokens: 0,
      autoCompact: true,
      id: SESSION_ID,
      maxContextTokens: null,
      reasoningEffort: "high",
      status: "queued",
      title: "Inspect README.md",
    });
    await completeAgentFileLookup(setup);
    await expectRunnerCommand(
      setup,
      {
        arguments: { path: "README.md" },
        executionEnvironment: "bare_metal",
        id: RUNNER_COMMAND_ID,
        sessionId: SESSION_ID,
        tool: "read",
        workingDirectory: "/work/project",
      },
      "The runner did not receive an agent command",
    );

    const resultResponse = completeRunnerCommand(setup, "# Q Mush");
    expect(resultResponse.status).toBe(204);
    const idle = await waitForSessionValue(
      () => sessionDetail(sessions),
      hasSessionStatus("idle"),
    );
    expect(JSON.stringify(idle)).toContain("README inspected.");
    expect(JSON.stringify(idle)).toContain(
      "I need to inspect README before answering.",
    );
    expect(JSON.stringify(idle)).toContain("# Q Mush");
    expect(idle).toMatchObject({ currentContextTokens: 13_000 });

    const followUp = await sessions.message(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/messages`,
        { images: [TEST_AGENT_IMAGE], prompt: "Now summarize it" },
        "POST",
      ),
      SESSION_ID,
    );
    expect(followUp.status).toBe(202);
    await completeAgentFileLookup(setup);
    const continued = await waitForSessionValue(
      () => sessionDetail(sessions),
      (value) => {
        const serialized = JSON.stringify(value);
        return (
          hasSessionStatus("idle")(value) &&
          serialized.includes("Follow-up complete.")
        );
      },
    );
    const followUpRequest = model.requests[2];
    expect(followUpRequest).toBeDefined();
    expect(JSON.stringify(continued)).toContain("Now summarize it");
    expect(followUpRequest).toContainEqual({
      content: "Now summarize it",
      images: [TEST_AGENT_IMAGE],
      role: "user",
    });

    const resumed = await sessions.continue(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/continue`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(resumed.status).toBe(202);
    await completeAgentFileLookup(setup);
    const continuationRequest = await waitForSessionValue(
      () => model.requests[3],
      (value) => value !== undefined,
    );
    if (followUpRequest === undefined) {
      throw new Error("The model did not receive the follow-up request");
    }
    expect(continuationRequest).toEqual([
      ...followUpRequest,
      { content: "Follow-up complete.", role: "assistant", toolCalls: [] },
    ]);
    expect(selectedReasoningEfforts).toEqual(["high", "high", "high"]);
    database.$client.close();
  });
});
