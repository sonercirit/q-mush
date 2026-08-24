import { describe, expect, test, vi } from "vitest";
import { runSessionAgent } from "../session-agent-runtime.ts";
import { currentExecutionTools } from "../session-agent-tool-authority.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { createScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  completedRunToolOutputs,
  completingTestBroker,
  IDLE_RUNTIME_SIGNALS,
  runtimeTestCredential,
} from "./session-agent-runtime-test-helpers.ts";
import { unusedSessionToolActions } from "./session-agent-tool-test-helpers.ts";
import {
  requireCompactionSession,
  runningCompactionStore,
} from "./session-compaction-test-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

function currentExecution(
  store: ReturnType<typeof runningCompactionStore>["store"],
  sessionId: string,
  generation: number,
): boolean {
  return store.executionIsCurrent(TEST_USER_ID, sessionId, generation);
}

describe("session agent tool authority", () => {
  test("retains persisted launch tools across a transient empty read", () => {
    const isCurrent = vi.fn(() => true);

    expect(
      currentExecutionTools({
        current: [],
        persisted: ["read", "bash", "parallel"],
        isCurrent,
      }),
    ).toEqual(["read", "bash", "parallel"]);
    expect(isCurrent).toHaveBeenCalledOnce();
  });

  test("keeps direct and parallel tools enabled after the live read empties", async () => {
    const setup = runningCompactionStore();
    const detail = requireCompactionSession(setup.store);
    const model = createScriptedAgentModel([
      {
        content: "Use one tool first.",
        toolCalls: [
          { arguments: "{}", id: "direct-call", name: "list_sessions" },
        ],
      },
      {
        content: "Use a parallel batch next.",
        toolCalls: [
          {
            arguments: JSON.stringify({
              tool_uses: [
                { parameters: {}, recipient_name: "list_sessions" },
                { parameters: {}, recipient_name: "list_runners" },
              ],
            }),
            id: "parallel-call",
            name: "parallel",
          },
        ],
      },
      { content: "Finished.", toolCalls: [] },
    ]);
    const broker = completingTestBroker();
    let toolReads = 0;
    let now = TEST_NOW + 2;

    const authorityRun = runSessionAgent({
      braveSearch: { execute: () => Promise.resolve("unused search") },
      broker,
      pendingComponent: () => undefined,
      credential: runtimeTestCredential(
        detail.credentialId,
        "Tool authority credential",
      ),
      currentTools: () => {
        toolReads += 1;
        return toolReads === 1 ? detail.tools : [];
      },
      detail,
      ...IDLE_RUNTIME_SIGNALS,
      isCurrent: () =>
        currentExecution(setup.store, detail.id, detail.generation),
      modelFactory: () => model,
      now: () => (now += 1),
      sessionTools: unusedSessionToolActions({
        listRunners: () => "runners remain enabled",
        listSessions: () => "sessions remain enabled",
      }),
      signal: new AbortController().signal,
      store: setup.store,
      userId: TEST_USER_ID,
    });

    const outputs = await completedRunToolOutputs(
      authorityRun,
      setup.store,
      detail.id,
    );
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toBe("sessions remain enabled");
    expect(outputs[1]).toContain("sessions remain enabled");
    expect(outputs[1]).toContain("runners remain enabled");
    expect(outputs.join("\n")).not.toContain("is not enabled");
    expect(toolReads).toBeGreaterThan(1);
    expect(setup.store.get(TEST_USER_ID, detail.id)?.tools).toEqual(
      detail.tools,
    );
    closeSessionTestDatabase(setup.database);
  });

  test("does not weaken generation fencing or intentional empty selections", () => {
    const fenced = vi.fn(() => false);
    expect(
      currentExecutionTools({
        current: ["read", "bash"],
        persisted: ["read", "bash"],
        isCurrent: fenced,
      }),
    ).toBeUndefined();
    expect(fenced).toHaveBeenCalledOnce();
    expect(
      currentExecutionTools({
        current: [],
        persisted: ["read", "bash"],
        isCurrent: () => false,
      }),
    ).toBeUndefined();
    expect(
      currentExecutionTools({
        current: [],
        persisted: [],
        isCurrent: () => true,
      }),
    ).toEqual([]);
    expect(
      currentExecutionTools({
        current: ["read"],
        persisted: ["read", "bash"],
        isCurrent: () => true,
      }),
    ).toEqual(["read"]);
  });
});
