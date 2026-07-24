import { describe, expect, test } from "vitest";
import { users } from "../../shared/database/schema.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import { DrizzleAuthStore } from "../../sync-engine/auth-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  createAuthenticatedRequest,
  TEST_NOW,
  TEST_USER_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { ControlledModel } from "./controlled-agent-model.ts";
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

// cpd-ignore-start -- Helpers intentionally mirror the established session integration fixture API.
async function expectJsonResponse(
  response: Response,
  status: number,
  expected: unknown,
): Promise<void> {
  const body: unknown = await response.json();
  expect(body).toEqual(expected);
  expect(response.status).toBe(status);
}

async function expectSessionReaches(
  setup: ReturnType<typeof connectedSessionSetup>,
  response: Response,
  status: string,
) {
  expect(response.status).toBe(201);
  await completeAgentFileLookup(setup);
  return waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus(status),
  );
}

function completingSessionSetup(content: string) {
  const model = new ScriptedAgentModel([{ content, toolCalls: [] }]);
  return { model, ...connectedSessionSetup(model) };
}
// cpd-ignore-end

// cpd-ignore-start -- Integration tests intentionally spell out each HTTP mutation and lifecycle boundary.
describe("pending session input integration", () => {
  test("queues steering and follow-ups with idempotent owned mutations", async () => {
    const model = new ControlledModel();
    const setup = connectedSessionSetup(model);
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 1,
    );

    const pendingRequest = (
      kind: "follow_up" | "steer",
      clientRequestId: string,
      prompt: string,
      images = kind === "steer" ? [TEST_AGENT_IMAGE] : [],
    ) =>
      setup.sessions.pendingInput(
        createAuthenticatedRequest(
          `${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
          { clientRequestId, images, kind, prompt },
          "POST",
        ),
        SESSION_ID,
      );
    const steer = await pendingRequest("steer", "steer-request", "Steer now");
    expect(steer.status).toBe(202);
    expect(await steer.json()).toMatchObject({
      pendingInputs: [
        { content: "Steer now", images: [TEST_AGENT_IMAGE], kind: "steer" },
      ],
      status: "running",
    });
    const duplicate = await pendingRequest(
      "steer",
      "steer-request",
      "Steer now",
    );
    expect(duplicate.status).toBe(200);
    const conflictingDuplicate = await pendingRequest(
      "follow_up",
      "steer-request",
      "Different input",
    );
    await expectJsonResponse(conflictingDuplicate, 409, {
      error: "pending_input_id_conflict",
    });
    const follow = await pendingRequest(
      "follow_up",
      "follow-request",
      "Do this next",
    );
    expect(follow.status).toBe(202);

    model.resolve({ content: "Current completion" });
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 2,
    );
    expect(model.requests[1]?.slice(-2)).toEqual([
      { content: "Current completion", role: "assistant", toolCalls: [] },
      {
        content: "Steer now",
        images: [TEST_AGENT_IMAGE],
        role: "user",
      },
    ]);
    model.resolve({ content: "Steered completion" });
    await completeAgentFileLookup(setup);

    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 3,
    );
    expect(model.requests[2]).toContainEqual({
      content: "Do this next",
      role: "user",
    });
    model.resolve({ content: "Follow-up completion" });
    const idle = await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    expect(idle).toMatchObject({ pendingInputs: [] });
    setup.database.$client.close();
  });

  test("resumes a retained follow-up before the first new completion", async () => {
    const model = new ControlledModel();
    const setup = connectedSessionSetup(model);
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 1,
    );

    const followUp = await setup.sessions.pendingInput(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
        {
          clientRequestId: "retained-follow-up",
          kind: "follow_up",
          prompt: "Run this after resuming",
        },
        "POST",
      ),
      SESSION_ID,
    );
    expect(followUp.status).toBe(202);
    const stopped = await setup.sessions.stop(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/stop`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(stopped.status).toBe(200);
    model.resolve({ content: "Canceled completion" });
    await Bun.sleep(1);

    const resumed = await setup.sessions.continue(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/continue`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(resumed.status).toBe(202);
    expect(await resumed.json()).toMatchObject({ pendingInputs: [] });
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 2,
    );
    expect(model.requests[1]?.at(-1)).toEqual({
      content: "Run this after resuming",
      role: "user",
    });
    model.resolve({ content: "Resumed completion" });
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    setup.database.$client.close();
  });

  test("rejects a new message while retained pending input owns FIFO", async () => {
    const model = new ControlledModel();
    const setup = connectedSessionSetup(model);
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 1,
    );

    expect(
      (
        await setup.sessions.pendingInput(
          createAuthenticatedRequest(
            `${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
            {
              clientRequestId: "retained-before-new-message",
              kind: "follow_up",
              prompt: "Older pending work",
            },
            "POST",
          ),
          SESSION_ID,
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await setup.sessions.stop(
          createAuthenticatedRequest(
            `${SESSIONS_PATH}/${SESSION_ID}/stop`,
            undefined,
            "POST",
          ),
          SESSION_ID,
        )
      ).status,
    ).toBe(200);
    model.resolve({ content: "Canceled completion" });
    await Bun.sleep(1);

    const message = await setup.sessions.message(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/messages`,
        { prompt: "New work must not leapfrog" },
        "POST",
      ),
      SESSION_ID,
    );

    await expectJsonResponse(message, 409, {
      error: "pending_session_input",
    });
    expect(await sessionDetail(setup.sessions)).toMatchObject({
      messages: [{ content: "Inspect README.md", role: "user" }],
      pendingInputs: [{ content: "Older pending work", kind: "follow_up" }],
      status: "stopped",
    });
    setup.database.$client.close();
  });

  test("resumes with retained steering before the first new completion", async () => {
    const model = new ControlledModel();
    const setup = connectedSessionSetup(model);
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 1,
    );

    const steering = await setup.sessions.pendingInput(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
        {
          clientRequestId: "retained-steer",
          kind: "steer",
          prompt: "Apply this after resuming",
        },
        "POST",
      ),
      SESSION_ID,
    );
    expect(steering.status).toBe(202);
    const stopped = await setup.sessions.stop(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/stop`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(stopped.status).toBe(200);
    model.resolve({ content: "Canceled completion" });
    await Bun.sleep(1);

    const resumed = await setup.sessions.continue(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/continue`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(resumed.status).toBe(202);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 2,
    );
    expect(model.requests[1]?.at(-1)).toEqual({
      content: "Apply this after resuming",
      role: "user",
    });
    model.resolve({ content: "Resumed completion" });
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    setup.database.$client.close();
  });

  test("retained mixed input stays in FIFO across stop and continue", async () => {
    const model = new ControlledModel();
    const setup = connectedSessionSetup(model);
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 1,
    );

    const enqueue = (
      kind: "follow_up" | "steer",
      clientRequestId: string,
      prompt: string,
    ) =>
      setup.sessions.pendingInput(
        createAuthenticatedRequest(
          `${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
          { clientRequestId, kind, prompt },
          "POST",
        ),
        SESSION_ID,
      );
    expect(
      (await enqueue("follow_up", "mixed-follow", "Next turn")).status,
    ).toBe(202);
    expect((await enqueue("steer", "mixed-steer", "Then steer")).status).toBe(
      202,
    );
    expect(
      (
        await setup.sessions.stop(
          createAuthenticatedRequest(
            `${SESSIONS_PATH}/${SESSION_ID}/stop`,
            undefined,
            "POST",
          ),
          SESSION_ID,
        )
      ).status,
    ).toBe(200);
    model.resolve({ content: "Canceled completion" });
    await Bun.sleep(1);

    expect(
      (
        await setup.sessions.continue(
          createAuthenticatedRequest(
            `${SESSIONS_PATH}/${SESSION_ID}/continue`,
            undefined,
            "POST",
          ),
          SESSION_ID,
        )
      ).status,
    ).toBe(202);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 2,
    );
    expect(model.requests[1]?.slice(-2)).toEqual([
      { content: "Next turn", role: "user" },
      { content: "Then steer", role: "user" },
    ]);
    model.resolve({ content: "Mixed work complete" });
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    setup.database.$client.close();
  });

  test("promotes a follow-up while offline and launches it on reconnect", async () => {
    const model = new ControlledModel();
    const setup = connectedSessionSetup(model);
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 1,
    );

    const followUp = await setup.sessions.pendingInput(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
        {
          clientRequestId: "offline-follow-up",
          kind: "follow_up",
          prompt: "Continue after reconnecting",
        },
        "POST",
      ),
      SESSION_ID,
    );
    expect(followUp.status).toBe(202);
    setup.runners.disconnected(setup.registration.connection);
    model.resolve({ content: "Current work complete" });

    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("queued"),
    );
    expect(model.requests).toHaveLength(1);

    setup.runners.seen(setup.registration.connection);
    setup.sessions.runnerConnected(TEST_USER_ID);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 2,
    );
    expect(model.requests[1]).toContainEqual({
      content: "Continue after reconnecting",
      role: "user",
    });
    model.resolve({ content: "Reconnected work complete" });
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    setup.database.$client.close();
  });

  test("does not orphan tool calls when steering arrives during a model turn", async () => {
    const model = new ControlledModel();
    const setup = connectedSessionSetup(model);
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 1,
    );

    const queued = await setup.sessions.pendingInput(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
        {
          clientRequestId: "steer-with-tools",
          kind: "steer",
          prompt: "Use the test file instead",
        },
        "POST",
      ),
      SESSION_ID,
    );
    expect(queued.status).toBe(202);
    model.resolve({
      content: "Reading first.",
      toolCalls: [
        {
          arguments: '{"path":"README.md"}',
          id: "model-call",
          name: "read",
        },
      ],
    });
    await expectRunnerCommand(
      setup,
      {
        arguments: { path: "README.md" },
        id: RUNNER_COMMAND_ID,
        sessionId: SESSION_ID,
        tool: "read",
        workingDirectory: "/work/project",
      },
      "The original tool call was not executed",
    );
    expect(completeRunnerCommand(setup, "# Result").status).toBe(204);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 2,
    );
    expect(model.requests[1]?.slice(-3)).toEqual([
      {
        content: "Reading first.",
        role: "assistant",
        toolCalls: [
          {
            arguments: '{"path":"README.md"}',
            id: "model-call",
            name: "read",
          },
        ],
      },
      {
        content: "# Result",
        role: "tool",
        toolCallId: "model-call",
        toolName: "read",
      },
      { content: "Use the test file instead", role: "user" },
    ]);
    model.resolve({ content: "Done" });
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    setup.database.$client.close();
  });

  test("rejects a real cross-user pending-input mutation without revealing the session", async () => {
    const model = new ControlledModel();
    const setup = connectedSessionSetup(model);
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);
    await waitForSessionValue(
      () => model.requests.length,
      (value) => value === 1,
    );

    const otherUserId = "018bcfe5-6800-7000-8000-000000000099";
    const otherToken = "other-authenticated-session";
    setup.database
      .insert(users)
      .values({
        ...testAuditFields(otherUserId),
        email: "other@example.com",
        googleSubject: "other-google-user",
        id: otherUserId,
        name: "Other User",
      })
      .run();
    const authStore = new DrizzleAuthStore(
      setup.database,
      () => "018bcfe5-6800-7000-8000-000000000098",
    );
    authStore.createSession(
      otherToken,
      {
        email: "other@example.com",
        googleSubject: "other-google-user",
        name: "Other User",
      },
      TEST_NOW + 60_000,
      TEST_NOW,
    );
    const request = new Request(
      `http://localhost:3000${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
      {
        body: JSON.stringify({
          clientRequestId: "cross-user-request",
          kind: "follow_up",
          prompt: "Do not allow this",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `q_mush_session=${otherToken}`,
        },
        method: "POST",
      },
    );

    const response = await setup.sessions.pendingInput(request, SESSION_ID);

    await expectJsonResponse(response, 404, { error: "not_found" });
    expect(await sessionDetail(setup.sessions)).toMatchObject({
      pendingInputs: [],
      status: "running",
    });
    model.resolve({ content: "Owner work complete" });
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    setup.database.$client.close();
  });

  test("rejects pending input for invalid state and another owner", async () => {
    const setup = completingSessionSetup("Done");
    const created = await setup.sessions.collection(createSessionRequest());
    await expectSessionReaches(setup, created, "idle");

    const invalidState = await setup.sessions.pendingInput(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/pending-inputs`,
        {
          clientRequestId: "late-steer",
          kind: "steer",
          prompt: "Too late",
        },
        "POST",
      ),
      SESSION_ID,
    );
    await expectJsonResponse(invalidState, 409, {
      error: "invalid_session_state",
    });
    const missing = await setup.sessions.pendingInput(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/another-session/pending-inputs`,
        {
          clientRequestId: "not-owned",
          kind: "follow_up",
          prompt: "No access",
        },
        "POST",
      ),
      "another-session",
    );
    await expectJsonResponse(missing, 404, { error: "not_found" });
    setup.database.$client.close();
  });
});
// cpd-ignore-end
