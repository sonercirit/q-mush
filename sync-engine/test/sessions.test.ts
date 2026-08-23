import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { AgentModel, AgentModelStep } from "../../shared/agent-loop.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { runnerDirectoriesPath, SESSIONS_PATH } from "../../shared/routes.ts";
import { createWorkspaceStore } from "../../sync-engine/workspace-store.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  completeRunnerCommand,
  directoryListing,
  expectedRunnerCommand,
  expectRunnerCommand,
  expectSessionReaches,
  sessionDetail,
  startSession,
  startSessionAndCompleteAgentFile,
  startSessionAndExpectRunnerCommand,
  waitForSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { expectJsonResponse } from "./session-launch-race-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

const SECOND_WORKSPACE_ID = "018bcfe5-6800-7000-8000-000000000081";
class FailingModel implements AgentModel {
  complete(): Promise<AgentModelStep> {
    return Promise.reject(new Error("Provider unavailable"));
  }
}

async function startSessionWithAgentFile(
  model: AgentModel,
  agentFile: unknown,
): Promise<Awaited<ReturnType<typeof connectedSessionSetup>>> {
  const setup = connectedSessionSetup(model);
  await startSessionAndCompleteAgentFile(setup, agentFile);
  await waitForSessionStatus(setup, "idle");
  return setup;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

async function sessionRequestInput(): Promise<
  Readonly<Record<string, unknown>>
> {
  const input: unknown = await createSessionRequest().json();
  if (!isObject(input)) {
    throw new Error("The session request fixture is invalid");
  }
  return input;
}

async function sessionRequestWithTools(
  tools: readonly string[],
): Promise<Request> {
  const input = await sessionRequestInput();
  return createAuthenticatedRequest(
    `${SESSIONS_PATH}?workspaceId=${encodeURIComponent(TEST_WORKSPACE_ID)}`,
    { ...input, tools },
    "POST",
  );
}

function emptySessionSetup(
  options?: Parameters<typeof connectedSessionSetup>[3],
) {
  return connectedSessionSetup(
    new ScriptedAgentModel([]),
    "api_key",
    undefined,
    options ?? {},
  );
}

function completingSessionSetup(content: string) {
  const model = new ScriptedAgentModel([{ content, toolCalls: [] }]);
  return { model, ...connectedSessionSetup(model) };
}

async function expectInvalidSessionRequest(
  setup: ReturnType<typeof emptySessionSetup>,
  request: Request,
): Promise<void> {
  const response = await setup.sessions.collection(request);
  await expectJsonResponse(response, 400, { error: "invalid_request" });
  setup.database.$client.close();
}

async function unauthenticatedSessionStatus(): Promise<number> {
  const setup = emptySessionSetup();
  const response = await setup.sessions.collection(
    new Request("http://localhost/api/sessions"),
  );
  setup.database.$client.close();
  return response.status;
}

describe("agent sessions", () => {
  test("uses the injected startup clock when recovering reservations", () => {
    const seeded = createStore();
    const child = createTestSession(seeded.store);
    seeded.database
      .update(agentSessions)
      .set({
        spawnPreparationPending: child.id.length > 0,
        updatedAt: new Date(TEST_NOW),
      })
      .where(
        and(eq(agentSessions.id, child.id), eq(agentSessions.status, "queued")),
      )
      .run();
    const recoveryNow = TEST_NOW + 9_876;

    const setup = connectedSessionSetup(
      new ScriptedAgentModel([]),
      "api_key",
      undefined,
      { database: seeded.database, now: () => recoveryNow },
    );

    const recovered = setup.database
      .select({
        status: agentSessions.status,
        updatedAt: agentSessions.updatedAt,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, child.id))
      .get();
    expect(recovered).toEqual({
      status: "failed",
      updatedAt: new Date(recoveryNow),
    });
    setup.database.$client.close();
  });

  test("requires an owned workspace for creation and every HTTP session item action", async () => {
    const setup = completingSessionSetup("Workspace isolation ready.");

    const input = await sessionRequestInput();
    const unavailableCreation = await setup.sessions.collection(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}?workspaceId=unavailable-workspace`,
        input,
        "POST",
      ),
    );
    await expectJsonResponse(unavailableCreation, 409, {
      error: "workspace_unavailable",
    });

    createWorkspaceStore(setup.database, () => SECOND_WORKSPACE_ID).create(
      TEST_USER_ID,
      "Second",
      TEST_NOW,
    );

    const created = await startSession(setup);
    await expectSessionReaches(setup, created, "idle");
    const path = `${SESSIONS_PATH}/${SESSION_ID}`;
    const scopedPath = (suffix = "") =>
      `${path}${suffix}?workspaceId=${encodeURIComponent(SECOND_WORKSPACE_ID)}`;
    const responses = await Promise.all([
      Promise.resolve(
        setup.sessions.item(
          createAuthenticatedRequest(scopedPath()),
          SESSION_ID,
        ),
      ),
      setup.sessions.message(
        createAuthenticatedRequest(
          scopedPath("/messages"),
          { prompt: "Do not cross scopes" },
          "POST",
        ),
        SESSION_ID,
      ),
      setup.sessions.compact(
        createAuthenticatedRequest(scopedPath("/compact"), undefined, "POST"),
        SESSION_ID,
      ),
      setup.sessions.compaction(
        createAuthenticatedRequest(
          scopedPath("/compaction"),
          { autoCompact: false },
          "POST",
        ),
        SESSION_ID,
      ),
      setup.sessions.continue(
        createAuthenticatedRequest(scopedPath("/continue"), undefined, "POST"),
        SESSION_ID,
      ),
      setup.sessions.reassign(
        createAuthenticatedRequest(
          scopedPath("/reassign"),
          { runnerId: RUNNER_ID, workingDirectory: "/tmp" },
          "POST",
        ),
        SESSION_ID,
      ),
      setup.sessions.stop(
        createAuthenticatedRequest(scopedPath("/stop"), undefined, "POST"),
        SESSION_ID,
      ),
    ]);

    expect(responses.every(({ status }) => status === 404)).toBe(true);
    setup.database.$client.close();
  });

  test("stores session failures as error messages and settles active timing", async () => {
    // Account for the shared injected timestamp read by startup repair/recovery.
    let now = TEST_NOW - 3_000;
    const setup = connectedSessionSetup(
      new FailingModel(),
      "api_key",
      undefined,
      { now: () => (now += 3_000) },
    );
    const response = await setup.sessions.collection(createSessionRequest());

    // Seven 3s ticks: shared startup recovery, two SessionRuntimes reads,
    // creation, message, failure, and settlement.
    expect(await expectSessionReaches(setup, response, "failed")).toMatchObject(
      {
        activeDurationMs: 18_000,
        activeStartedAt: null,
        messages: [
          { role: "user" },
          { content: "Session failed: Provider unavailable", role: "error" },
        ],
      },
    );
    setup.database.$client.close();
  });

  test("rejects an unavailable runner before reading the credential", async () => {
    let credentialReads = 0;
    const setup = emptySessionSetup({
      onCredentialRead: () => {
        credentialReads += 1;
      },
    });
    const input = await sessionRequestInput();
    const response = await setup.sessions.collection(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}?workspaceId=${encodeURIComponent(TEST_WORKSPACE_ID)}`,
        { ...input, runnerId: "01936a52-0000-7000-8000-00000000dead" },
        "POST",
      ),
    );
    // Fail closed: no credential is read (or decrypted) for a runner the user
    // cannot reach, and the restart gate shares this ordering.
    await expectJsonResponse(response, 409, { error: "runner_unavailable" });
    expect(credentialReads).toBe(0);
    setup.database.$client.close();
  });

  test("persists disabled auto-compaction from HTTP creation", async () => {
    const setup = completingSessionSetup("Auto-compaction stayed disabled.");
    const response = await setup.sessions.collection(
      createSessionRequest(true, "high", "gpt-4.1-mini", [], false),
    );

    expect(await response.clone().json()).toMatchObject({ autoCompact: false });
    expect(await expectSessionReaches(setup, response, "idle")).toMatchObject({
      autoCompact: false,
    });
    setup.database.$client.close();
  });

  test("rejects a non-boolean creation auto-compaction value", async () => {
    const setup = emptySessionSetup();
    const input = await sessionRequestInput();
    await expectInvalidSessionRequest(
      setup,
      createAuthenticatedRequest(
        `${SESSIONS_PATH}?workspaceId=${encodeURIComponent(TEST_WORKSPACE_ID)}`,
        { ...input, autoCompact: "false" },
        "POST",
      ),
    );
  });

  test("persists images and timing and sends them to the model", async () => {
    const expiry = TEST_NOW + 7 * 86_400_000;
    let now = TEST_NOW;
    const model = new ScriptedAgentModel([
      { content: "Screenshot implemented.", toolCalls: [] },
    ]);
    const database = createAuthenticatedTestDatabase({ expiresAt: expiry });
    const setup = connectedSessionSetup(model, "api_key", undefined, {
      database,
      now: () => (now += 3_000),
    });
    const imageRequest = createSessionRequest(true, "high", "gpt-4.1-mini", [
      TEST_AGENT_IMAGE,
    ]);
    const response = await setup.sessions.collection(imageRequest);

    expect(await expectSessionReaches(setup, response, "idle")).toMatchObject({
      activeDurationMs: 18_000,
      activeStartedAt: null,
      messages: [
        {
          images: [TEST_AGENT_IMAGE],
          role: "user",
        },
        { role: "assistant" },
      ],
    });
    expect(model.requests[0]?.[0]).toEqual({
      content: "Inspect README.md",
      images: [TEST_AGENT_IMAGE],
      role: "user",
    });

    setup.database.$client.close();
  });

  test("loads the workspace agent file before starting the model", async () => {
    const model = new ScriptedAgentModel([
      { content: "Instructions followed.", toolCalls: [] },
    ]);
    const setup = await startSessionWithAgentFile(model, {
      content: "Use the repository test command.",
      name: "CLAUDE.md",
    });

    expect(setup.selectedSystemPrompts).toHaveLength(1);
    expect(setup.selectedSystemPrompts[0]).toContain("CLAUDE.md");
    expect(setup.selectedSystemPrompts[0]).toContain(
      "Use the repository test command.",
    );
    expect(await sessionDetail(setup.sessions)).toMatchObject({
      agentFile: {
        content: "Use the repository test command.",
        name: "CLAUDE.md",
      },
    });
    setup.database.$client.close();
  });

  test("accepts agent instructions without a runner-result size limit", async () => {
    const model = new ScriptedAgentModel([
      { content: "Large instructions loaded.", toolCalls: [] },
    ]);
    const content = "x".repeat(600 * 1_024);
    const setup = await startSessionWithAgentFile(model, {
      content,
      name: "AGENTS.md",
    });

    expect(setup.selectedSystemPrompts[0]).toContain(content);
    setup.database.$client.close();
  });

  test("browses directories through an owned online runner", async () => {
    const setup = connectedSessionSetup(new ScriptedAgentModel([]), "api_key");
    const browseResponse = setup.sessions.directories(
      createAuthenticatedRequest(
        runnerDirectoriesPath(RUNNER_ID),
        { path: "~/projects" },
        "POST",
      ),
      RUNNER_ID,
    );

    await expectRunnerCommand(
      setup,
      expectedRunnerCommand({
        arguments: {},
        sessionId: `directory-picker:${TEST_USER_ID}`,
        tool: "list_directories",
        workingDirectory: "~/projects",
      }),
      "The runner did not receive a directory command",
    );

    const listing = directoryListing();
    const resultResponse = completeRunnerCommand(
      setup,
      JSON.stringify(listing),
    );

    expect(resultResponse.status).toBe(204);
    await expectJsonResponse(await browseResponse, 200, listing);
    setup.database.$client.close();
  });

  test("rejects a missing model or unsupported reasoning effort", async () => {
    for (const request of [
      createSessionRequest(false),
      createSessionRequest(true, "maximum"),
    ]) {
      await expectInvalidSessionRequest(emptySessionSetup(), request);
    }
  });

  test("runs a session with only its selected tools and skills", async () => {
    const model = new ScriptedAgentModel([
      { content: "Selection respected.", toolCalls: [] },
    ]);
    const setup = connectedSessionSetup(model);
    const response = await setup.sessions.collection(
      await sessionRequestWithTools(["read", "brave_search"]),
    );

    await expectSessionReaches(setup, response, "idle");
    expect(setup.selectedTools).toEqual([["read", "brave_search"]]);
    const selectedDetail = await sessionDetail(setup.sessions);
    expect(selectedDetail).toMatchObject({ tools: ["read", "brave_search"] });
    setup.database.$client.close();
  });

  test("rejects duplicate or unknown tool selections", async () => {
    for (const tools of [
      ["read", "read"],
      ["read", "unknown_tool"],
    ]) {
      const setup = emptySessionSetup();
      await expectInvalidSessionRequest(
        setup,
        await sessionRequestWithTools(tools),
      );
    }
  });

  test("hands off a durable tool step and resumes only after explicit recovery", async () => {
    const restartCall = {
      arguments: '{"command":"bun run dev:restart","timeout":30}',
      id: "restart-call",
      name: "bash",
    };
    const model = new ScriptedAgentModel([
      {
        content: "Requesting a development restart.",
        toolCalls: [restartCall],
      },
      { content: "Restart completed.", toolCalls: [] },
    ]);
    const setup = connectedSessionSetup(model);
    const { sessions } = setup;
    await startSessionAndExpectRunnerCommand(
      setup,
      expectedRunnerCommand({
        arguments: {
          command: "bun run dev:restart",
          timeout: 30,
        },
        tool: "bash",
      }),
      "The runner did not receive the restart command",
    );

    let drained = false;
    const drain = sessions.drain().then(() => {
      drained = true;
    });
    await Bun.sleep(1);
    expect(drained).toBe(false);
    const createDuringRestart = await sessions.collection(
      createSessionRequest(),
    );
    expect(createDuringRestart.status).not.toBe(201);

    expect(completeRunnerCommand(setup, "Restart requested.").status).toBe(204);
    await drain;
    expect(model.requests).toHaveLength(1);
    expect(await sessionDetail(sessions)).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant", toolCalls: [restartCall] },
        { content: "Restart requested.", role: "tool" },
      ],
      restartHandoff: {
        operation: "agent",
        requestedBy: "server",
      },
      status: "paused",
    });
    const recovered = connectedSessionSetup(model, "api_key", undefined, {
      database: setup.database,
      onChange: () => undefined,
    });
    await completeAgentFileLookup(recovered);
    await waitForSessionValue(
      () => sessionDetail(recovered.sessions),
      (detail) => {
        if (typeof detail !== "object" || detail === null) {
          return false;
        }
        return (
          JSON.stringify(detail).includes("Restart completed.") &&
          "status" in detail &&
          detail.status === "idle"
        );
      },
    );
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toContainEqual({
      content: "Restart requested.",
      role: "tool",
      toolCallId: restartCall.id,
      toolName: restartCall.name,
    });
    const recoveredDetail = await sessionDetail(recovered.sessions);
    expect(recoveredDetail).toMatchObject({
      restartHandoff: null,
      status: "idle",
    });
    expect(JSON.stringify(recoveredDetail)).toContain("Restart completed.");
    setup.database.$client.close();
  });

  test("protects session endpoints", async () => {
    expect(await unauthenticatedSessionStatus()).toBe(401);
  });
});
