import { describe, expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import {
  createAuthenticatedRequest,
  TEST_AUTHENTICATED_USER,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  createSpawnSessionInput,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeRunnerCommand,
  expectSessionReaches,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

interface BlockingModel extends AgentModel {
  readonly aborted: boolean;
  readonly started: boolean;
}

function createBlockingModel(): BlockingModel {
  let aborted = false;
  let started = false;
  return {
    get aborted() {
      return aborted;
    },
    get started() {
      return started;
    },
    complete(
      _messages: readonly AgentConversationMessage[],
      signal?: AbortSignal,
    ): Promise<AgentModelStep> {
      started = true;
      return new Promise((_resolve, reject) => {
        const stop = () => {
          aborted = true;
          reject(new DOMException("Stopped", "AbortError"));
        };
        if (signal?.aborted === true) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      });
    },
  };
}
async function stopHttpSession(
  setup: ReturnType<typeof connectedSessionSetup>,
  cascade?: boolean | string,
): Promise<Response> {
  const body = cascade === undefined ? undefined : ({ cascade } as const);
  return setup.sessions.stop(
    createAuthenticatedRequest(
      `${SESSIONS_PATH}/${SESSION_ID}/stop?workspaceId=${encodeURIComponent(TEST_WORKSPACE_ID)}`,
      body,
      "POST",
    ),
    SESSION_ID,
  );
}

describe("agent session stop semantics", () => {
  test("stopping a running model request settles its active duration", async () => {
    let now = TEST_NOW;
    const model = createBlockingModel();
    const setup = connectedSessionSetup(model, "api_key", undefined, {
      now: () => now,
    });
    const { database, sessions } = setup;
    const created = await sessions.collection(createSessionRequest());
    await expectSessionReaches(setup, created, "running");
    const running = await sessionDetail(sessions);
    expect(running).toMatchObject({
      activeDurationMs: 0,
      activeStartedAt: TEST_NOW,
      status: "running",
    });
    now += 18_500;

    const stopped = await stopHttpSession(setup);

    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      activeDurationMs: 18_500,
      activeStartedAt: null,
      status: "stopped",
    });
    await waitForSessionValue(
      () => model.aborted,
      (value) => value === true,
    );
    expect(model.started).toBe(true);
    database.$client.close();
  });

  test("omitted HTTP stop body cascade-stops actual children", async () => {
    const setup = connectedSessionSetup(createBlockingModel());
    const createResponse = await setup.sessions.collection(
      createSessionRequest(),
    );
    await expectSessionReaches(setup, createResponse, "running");
    const parent = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
    const child = await setup.sessions.realtimeCommands.spawnForUser(
      TEST_AUTHENTICATED_USER,
      await createSpawnSessionInput(SESSION_ID, parent?.generation ?? -1),
      TEST_WORKSPACE_ID,
    );
    expect(child.status).toBe("queued");
    await waitForSessionValue(
      () => setup.latestRunnerCommand()?.sessionId,
      (sessionId) => sessionId === child.id,
    );
    expect(completeRunnerCommand(setup, "null").status).toBe(204);
    await waitForSessionValue(
      () => setup.sessions.detailForUser(TEST_USER_ID, child.id)?.status,
      (status) => status === "running",
    );

    const stopped = await stopHttpSession(setup);

    const stoppedBody: unknown = await stopped.json();
    expect({ body: stoppedBody, status: stopped.status }).toMatchObject({
      body: { status: "stopped" },
      status: 200,
    });
    const childStatus = setup.sessions.detailForUser(
      TEST_USER_ID,
      child.id,
    )?.status;
    expect(childStatus).toBe("stopped");
    setup.database.$client.close();
  });

  test("accepts explicit HTTP parent-only stop semantics", async () => {
    const setup = connectedSessionSetup(createBlockingModel());
    await expectSessionReaches(
      setup,
      await setup.sessions.collection(createSessionRequest()),
      "running",
    );

    const stopped = await stopHttpSession(setup, false);

    expect(await stopped.json()).toMatchObject({ status: "stopped" });
    expect(stopped.status).toBe(200);
    setup.database.$client.close();
  });

  test("rejects malformed HTTP stop semantics", async () => {
    const setup = connectedSessionSetup(createBlockingModel());
    await setup.sessions.collection(createSessionRequest());

    const stopped = await stopHttpSession(setup, "false");

    expect(await stopped.json()).toEqual({ error: "invalid_request" });
    expect(stopped.status).toBe(400);
    setup.database.$client.close();
  });
});
