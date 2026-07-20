import { describe, expect, test } from "bun:test";
import { SESSIONS_PATH } from "../routes.ts";
import type { createSessionIntegration } from "../sessions.ts";
import {
  createAuthenticatedRequest,
  createRunnerRequest,
} from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_COMMAND_ID,
  RUNNER_COMMAND_PATH,
  RUNNER_TOKEN,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  completeRunnerCommand,
  hasSessionStatus,
  sessionDetail,
  takeRunnerCommand,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

async function commandActivity(
  sessions: ReturnType<typeof createSessionIntegration>,
): Promise<unknown> {
  const response = await sessions.workResult(
    createRunnerRequest(RUNNER_COMMAND_PATH, RUNNER_TOKEN, undefined, "GET"),
    RUNNER_COMMAND_ID,
  );
  return response.json();
}

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
    const { database, selectedReasoningEfforts, sessions } =
      await connectedSessionSetup(model);
    const createResponse = await sessions.collection(createSessionRequest());

    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toMatchObject({
      currentContextTokens: 0,
      id: SESSION_ID,
      maxContextTokens: null,
      reasoningEffort: "high",
      status: "queued",
      title: "Inspect README.md",
    });
    await completeAgentFileLookup(sessions);

    const workResponse = await takeRunnerCommand(
      sessions,
      "The runner did not receive an agent command",
    );

    const command: unknown = await workResponse.json();
    expect(command).toEqual({
      command: {
        arguments: { path: "README.md" },
        id: RUNNER_COMMAND_ID,
        sessionId: SESSION_ID,
        tool: "read",
        workingDirectory: "/work/project",
      },
    });
    expect(JSON.stringify(command)).not.toContain("provider-secret");
    expect(await commandActivity(sessions)).toEqual({
      active: true,
    });

    const resultResponse = await completeRunnerCommand(sessions, "# Q Mush");
    expect(resultResponse.status).toBe(204);
    expect(await commandActivity(sessions)).toEqual({
      active: false,
    });
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
        { prompt: "Now summarize it" },
        "POST",
      ),
      SESSION_ID,
    );
    expect(followUp.status).toBe(202);
    await completeAgentFileLookup(sessions);
    const continued = await waitForSessionValue(
      () => sessionDetail(sessions),
      (value) =>
        hasSessionStatus("idle")(value) &&
        JSON.stringify(value).includes("Follow-up complete."),
    );
    const followUpRequest = model.requests[2];
    expect(followUpRequest).toBeDefined();
    expect(JSON.stringify(continued)).toContain("Now summarize it");

    const resumed = await sessions.continue(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/continue`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(resumed.status).toBe(202);
    await completeAgentFileLookup(sessions);
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
