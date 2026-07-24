import { describe, expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { RUNNERS_PATH, SESSIONS_PATH } from "../../shared/routes.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  REPLACEMENT_RUNNER_ID,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  expectedRunnerCommand,
  expectRunnerRequired,
  expectTranscriptExcludes,
  hasSessionStatus,
  sessionDetail,
  startSession,
  startSessionAndExpectRunnerCommand,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

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
    new ScriptedAgentModel([
      { content: "Initial work complete.", toolCalls: [] },
    ]),
  );
}

async function expectSessionReaches(
  setup: ReturnType<typeof connectedSessionSetup>,
  response: Response,
  status: string,
): Promise<unknown> {
  expect(response.status).toBe(201);
  await completeAgentFileLookup(setup);
  return waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus(status),
  );
}

async function removeAssignedRunner(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<Response> {
  return setup.runners.remove(
    createAuthenticatedRequest(
      `${RUNNERS_PATH}/${RUNNER_ID}`,
      undefined,
      "DELETE",
    ),
    RUNNER_ID,
  );
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
  expect((await removeAssignedRunner(setup)).status).toBe(204);
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
  test("cancels active runner work and fences late results on removal", async () => {
    const model = new ScriptedAgentModel([
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
      (value) => isRecord(value) && value["runnerRequired"] === true,
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
          message["toolName"] === "bash",
      ),
    ).toBe(true);
    expect(
      setup.sessions.completeRunnerCommand(
        RUNNER_ID,
        RUNNER_COMMAND_ID,
        "late output",
      ),
    ).toBe(false);
    await expectTranscriptExcludes(setup, "late output");
    setup.database.$client.close();
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
