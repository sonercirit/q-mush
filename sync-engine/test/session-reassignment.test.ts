import { describe, expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { RUNNERS_PATH, SESSIONS_PATH } from "../../shared/routes.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import { createScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  REPLACEMENT_RUNNER_ID,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  expectedRunnerCommand,
  expectRunnerRequired,
  expectSessionReaches,
  expectTranscriptExcludes,
  sessionDetail,
  startSession,
  startSessionAndExpectRunnerCommand,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import {
  closeRaceSetup,
  credentialRaceSetup,
  expectNoStoredSessions,
  expectRaceRejection,
  finishRemovalRace,
  rejectRaceAndClose,
} from "./session-reassignment-race-helpers.ts";
import {
  expectRemovedRunner,
  postSessionAction,
  removeAssignedRunner,
} from "./session-reassignment-test-helpers.ts";

function addReplacementRunner(
  setup: ReturnType<typeof connectedSessionSetup>,
): string {
  const response = setup.runners.collection(
    createAuthenticatedRequest(RUNNERS_PATH, undefined, "POST"),
  );
  expect(response.status).toBe(201);
  const connected = setup.runners.connect("qmr_replacement-runner-token", {
    architecture: "arm64",
    machineFingerprint: "replacement-session-machine",
    name: "replacement",
    platform: "linux",
  });
  expect(connected?.connection.id).toBe(REPLACEMENT_RUNNER_ID);
  return REPLACEMENT_RUNNER_ID;
}

function completingSessionSetup() {
  return connectedSessionSetup(
    createScriptedAgentModel([
      { content: "Initial work complete.", toolCalls: [] },
    ]),
  );
}

function isSessionStillRecoverable(value: unknown): boolean {
  return isRecord(value) && value["runnerRequired"] === true;
}

async function stopSession(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<void> {
  const response = await postSessionAction(setup, "stop");
  expect(response.status).toBe(200);
}

async function createIdleSession(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<void> {
  const created = await startSession(setup);
  await expectSessionReaches(setup, created, "idle");
}

async function recoverCompletedSession() {
  const setup = completingSessionSetup();
  await createIdleSession(setup);
  await expectRemovedRunner(setup);
  return setup;
}

async function reassignRequest(
  setup: ReturnType<typeof connectedSessionSetup>,
  runnerId: string,
  workingDirectory: string,
): Promise<Response> {
  return setup.sessions.reassign(
    createAuthenticatedRequest(
      `${SESSIONS_PATH}/${SESSION_ID}/reassign`,
      { runnerId, workingDirectory },
      "POST",
    ),
    SESSION_ID,
  );
}

describe("runner reassignment", () => {
  test("rejects create when runner removal wins a credential race", async () => {
    const race = credentialRaceSetup(false);
    const creation = startSession(race.setup);
    const response = await finishRemovalRace(race, creation);

    await expectRaceRejection(race.setup, response, "runner_unavailable");
    expectNoStoredSessions(race.setup);
    closeRaceSetup(race.setup);
  });

  test("rejects continue and message when removal wins a credential race", async () => {
    const race = credentialRaceSetup();
    const continueRequest = postSessionAction(race.setup, "continue");
    const continued = await finishRemovalRace(race, continueRequest);

    await rejectRaceAndClose(race, continued, "runner_required");
  });

  test("rejects a follow-up message when removal wins a credential race", async () => {
    const race = credentialRaceSetup();
    const before = await sessionDetail(race.setup.sessions);
    const messageRequest = race.setup.sessions.message(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/messages`,
        { prompt: "Do not persist this stale message" },
        "POST",
      ),
      SESSION_ID,
    );
    const response = await finishRemovalRace(race, messageRequest);

    await expectRaceRejection(race.setup, response, "runner_required");
    const after = await sessionDetail(race.setup.sessions);
    expect(JSON.stringify(after)).not.toContain(
      "Do not persist this stale message",
    );
    expect(after).not.toEqual(before);
    closeRaceSetup(race.setup);
  });

  test("rejects manual compaction when removal wins a credential race", async () => {
    const race = credentialRaceSetup();
    const compaction = postSessionAction(race.setup, "compact");
    const response = await finishRemovalRace(race, compaction);

    await rejectRaceAndClose(race, response, "runner_required");
  });

  test("cancels active runner work and fences late results on removal", async () => {
    const model = createScriptedAgentModel([
      {
        content: "Running a command.",
        toolCalls: [
          {
            arguments: '{"command":"sleep 30","timeout":60}',
            id: "call-bash",
            name: "bash",
          },
        ],
      },
    ]);
    const setup = connectedSessionSetup(model);
    await startSessionAndExpectRunnerCommand(
      setup,
      expectedRunnerCommand({
        arguments: { command: "sleep 30", timeout: 60 },
        tool: "bash",
      }),
      "The runner did not receive the active command",
    );

    const removal = await removeAssignedRunner(setup);
    expect(removal.status).toBe(204);
    const recovered = await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      isSessionStillRecoverable,
    );
    expect(recovered).toMatchObject({
      runnerRequired: true,
      status: "idle",
    });
    if (!isRecord(recovered) || !Array.isArray(recovered["messages"])) {
      throw new Error("The recovered session transcript is unavailable");
    }
    const messages: readonly unknown[] = recovered["messages"];
    expect(
      messages.some(
        (message) =>
          isRecord(message) &&
          message["content"] ===
            "Error: the runner was removed before this tool call returned a result." &&
          message["role"] === "tool" &&
          message["toolCallId"] === "call-bash" &&
          message["toolName"] === "bash",
      ),
    ).toBe(true);
    expect(
      setup.sessions.completeRunnerCommand(RUNNER_ID, RUNNER_COMMAND_ID, {
        output: "late output",
        state: "completed",
      }),
    ).toBe(false);
    await expectTranscriptExcludes(setup, "late output");
    setup.database.$client.close();
  });

  test("keeps stopped sessions recoverable in both stop/removal orders", async () => {
    for (const order of ["stop_then_remove", "remove_then_stop"] as const) {
      const setup = completingSessionSetup();
      await createIdleSession(setup);
      if (order === "stop_then_remove") {
        await stopSession(setup);
        await expectRemovedRunner(setup);
      } else {
        await expectRemovedRunner(setup);
        await stopSession(setup);
      }
      expect(await sessionDetail(setup.sessions)).toMatchObject({
        runnerRequired: true,
        status: "stopped",
      });
      const replacementId = addReplacementRunner(setup);
      const reassigned = await reassignRequest(
        setup,
        replacementId,
        "/replacement/stopped-project",
      );
      expect(reassigned.status).toBe(200);
      expect(await reassigned.json()).toMatchObject({
        runnerRequired: false,
        status: "stopped",
      });
      setup.database.$client.close();
    }
  });

  test("reassigns to an owned online runner and does not auto-run", async () => {
    const setup = await recoverCompletedSession();
    const replacementId = addReplacementRunner(setup);
    const before = await sessionDetail(setup.sessions);
    const response = await reassignRequest(
      setup,
      replacementId,
      "/replacement/project",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        runnerId: replacementId,
        runnerRequired: false,
        status: "idle",
        workingDirectory: "/replacement/project",
      }),
    );
    const after = await sessionDetail(setup.sessions);
    expect(JSON.stringify(after)).toContain("Initial work complete.");
    expect(JSON.stringify(after)).toContain("Inspect README.md");
    expect(setup.runnerCommands).toEqual([]);
    expect(after).not.toEqual(before);
    setup.database.$client.close();
  });

  test("requires an owned online replacement and explicit new path", async () => {
    const setup = await recoverCompletedSession();
    const required = await sessionDetail(setup.sessions);
    expectRunnerRequired(required);

    const unavailable = await reassignRequest(
      setup,
      "missing-runner",
      "/new/project",
    );
    expect(unavailable.status).toBe(409);
    const invalid = await reassignRequest(setup, "missing-runner", "");
    expect(invalid.status).toBe(400);
    expect(await sessionDetail(setup.sessions)).toEqual(required);
    setup.database.$client.close();
  });
});
