import { describe, expect, test } from "vitest";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  addForeignReplacementRunner,
  addReplacementRunner,
  expectStoredSession,
  removeTestRunner,
} from "./session-store-reassignment-helpers.ts";
import { createSessionStoreTestSetup } from "./session-store-test-helpers.ts";

const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000041";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000043";

function runningStore() {
  return createSessionStoreTestSetup();
}

describe("session store runner reassignment", () => {
  test("reassigns only an owned runner-required session with a new path", () => {
    const { database, store } = runningStore();
    const replacementId = "018bcfe5-6800-7000-8000-000000000099";
    addReplacementRunner(database, replacementId);
    expect(removeTestRunner({ database, store }, RUNNER_ID, TEST_NOW + 4)).toBe(
      true,
    );

    const before = store.get(TEST_USER_ID, SESSION_ID);
    expect(
      store.reassign(
        "another-user",
        SESSION_ID,
        replacementId,
        "/replacement/project",
        TEST_NOW + 4,
      ),
    ).toEqual({ status: "not_found" });
    const reassigned = store.reassign(
      TEST_USER_ID,
      SESSION_ID,
      replacementId,
      "/replacement/project",
      TEST_NOW + 4,
    );
    expect(reassigned.status).toBe("reassigned");
    expect(reassigned).toMatchObject({
      detail: {
        runnerId: replacementId,
        runnerRequired: false,
        status: "idle",
        workingDirectory: "/replacement/project",
      },
    });
    const after = store.get(TEST_USER_ID, SESSION_ID);
    expect(after?.messages).toEqual(before?.messages);
    expect(after?.costUsd).toBe(before?.costUsd);
    expect(after?.tools).toEqual(before?.tools);
    database.$client.close();
  });

  test("rejects a foreign or offline replacement inside the store transaction", () => {
    const { database, store } = runningStore();
    const foreignId = "018bcfe5-6800-7000-8000-000000000097";
    addForeignReplacementRunner(database, foreignId);
    const removed = removeTestRunner(
      { database, store },
      RUNNER_ID,
      TEST_NOW + 4,
    );
    expect(removed).toBe(true);

    expect(
      store.reassign(
        TEST_USER_ID,
        SESSION_ID,
        foreignId,
        "/foreign/project",
        TEST_NOW + 4,
      ),
    ).toEqual({ status: "runner_unavailable" });
    expectStoredSession(store, SESSION_ID, {
      runnerId: RUNNER_ID,
      runnerRequired: true,
    });

    const offlineId = "018bcfe5-6800-7000-8000-000000000096";
    addReplacementRunner(database, offlineId);
    new RunnerStore(database).setOnline(
      offlineId,
      TEST_USER_ID,
      TEST_NOW + 5,
      false,
    );
    const offlineReassignment = store.reassign(
      TEST_USER_ID,
      SESSION_ID,
      offlineId,
      "/offline/project",
      TEST_NOW + 5,
    );
    expect(offlineReassignment).toEqual({ status: "runner_unavailable" });
    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      runnerId: RUNNER_ID,
      runnerRequired: true,
    });
    database.$client.close();
  });

  test("records the first unresolved model call once for parallel runner commands", () => {
    const setup = runningStore();
    const assistant = {
      content: "Running parallel work",
      role: "assistant" as const,
      toolCalls: [
        { arguments: "{}", id: "call-complete", name: "read" },
        { arguments: "{}", id: "call-parallel", name: "parallel" },
      ],
    };
    setup.store.appendAgentMessage(SESSION_ID, assistant, TEST_NOW + 2);
    setup.store.appendAgentMessage(
      SESSION_ID,
      {
        content: "done",
        role: "tool",
        toolCallId: "call-complete",
        toolName: "read",
      },
      TEST_NOW + 3,
    );

    setup.store.appendInterruptedRunnerTool(SESSION_ID, TEST_NOW + 4);

    const messages = setup.store.get(TEST_USER_ID, SESSION_ID)?.messages ?? [];
    const interrupted = messages.filter(
      ({ toolName }) => toolName === "parallel",
    );
    expect(interrupted).toEqual([
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-parallel",
        toolName: "parallel",
      }),
    ]);
    setup.database.$client.close();
  });

  test("rejects model writes after runner removal", () => {
    const { database, store } = runningStore();
    expect(removeTestRunner({ database, store }, RUNNER_ID)).toBe(true);
    const before = store.get(TEST_USER_ID, SESSION_ID);

    const lateOutput = {
      content: "Late model output",
      role: "assistant" as const,
      toolCalls: [],
    };
    expect(() => {
      store.appendAgentMessage(SESSION_ID, lateOutput, TEST_NOW + 3);
    }).toThrow("agent session was stopped");
    store.updateUsage(
      SESSION_ID,
      { contextTokens: 10, costBasis: "reported", costUsd: 1 },
      TEST_NOW + 3,
    );
    store.setAgentFile(SESSION_ID, null, TEST_NOW + 3);
    expect(store.get(TEST_USER_ID, SESSION_ID)).toEqual(before);
    database.$client.close();
  });
});
