import { describe, expect, test, vi } from "vitest";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import { MAXIMUM_TOOL_EXECUTION_MS } from "../../shared/tool-limits.ts";
import { runSessionAgent } from "../session-agent-runtime.ts";
import { executeSessionAgentTool } from "../session-agent-tools.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
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

interface LimitSetup {
  readonly database: ReturnType<typeof runningCompactionStore>["database"];
  readonly detail: ReturnType<typeof requireCompactionSession>;
  readonly store: ReturnType<typeof runningCompactionStore>["store"];
}

function limitRuntimeOptions(
  setup: Pick<LimitSetup, "detail" | "store">,
  label: string,
) {
  let now = TEST_NOW + 2;
  return {
    userId: TEST_USER_ID,
    store: setup.store,
    signal: new AbortController().signal,
    sessionTools: unusedSessionToolActions(),
    now: () => (now += 1),
    isCurrent: () => true,
    ...IDLE_RUNTIME_SIGNALS,
    detail: setup.detail,
    credential: runtimeTestCredential(setup.detail.credentialId, label),
    braveSearch: { execute: () => Promise.resolve("unused") },
  };
}

async function withLimitSetup(
  run: (setup: LimitSetup) => Promise<void>,
): Promise<void> {
  vi.useFakeTimers();
  try {
    const setup = runningCompactionStore();
    const detail = requireCompactionSession(setup.store);
    await run({ database: setup.database, detail, store: setup.store });
  } finally {
    vi.useRealTimers();
  }
}

// Let loadModels finish, start the first scripted model step, and enter its
// tool dispatch before advancing the newly registered deadline timer.
async function advancePastLimit(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(MAXIMUM_TOOL_EXECUTION_MS);
}

async function expectTimedOutRunOutput(
  run: Promise<"complete" | "handoff">,
  setup: LimitSetup,
): Promise<void> {
  const outputs = await completedRunToolOutputs(
    run,
    setup.store,
    setup.detail.id,
  );
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toContain("30-minute limit");
}

describe("global tool time limit integration", () => {
  test("fails a hung runner tool call at the limit and finishes the run", () =>
    withLimitSetup(async (setup) => {
      const hungReadCall = {
        arguments: '{"path":"a.txt"}',
        id: "hung-call",
        name: "read",
      };
      const model = new ScriptedAgentModel([
        { content: "Read the file.", toolCalls: [hungReadCall] },
        { content: "Finished after the timeout.", toolCalls: [] },
      ]);
      // The broker answers the agent-file load, then the runner goes
      // silent for the session's actual tool call.
      const broker = completingTestBroker((tool) => tool === "read_agent_file");
      const run = runSessionAgent({
        ...limitRuntimeOptions(setup, "Time limit credential"),
        broker,
        modelFactory: () => model,
      });
      await advancePastLimit();

      await expectTimedOutRunOutput(run, setup);
      closeSessionTestDatabase(setup.database);
    }));

  test("forwards the per-call deadline signal to session tool actions", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const record = (signal: AbortSignal) => {
      signals.push(signal);
      return Promise.resolve("recorded");
    };
    const actions = unusedSessionToolActions({
      browseRunnerDirectories: (_runnerId, _path, signal) => record(signal),
      getSessionOptions: (_input, signal) => record(signal),
      spawnSession: (_input, signal) => record(signal),
    });
    const deadline = new AbortController();
    const dispatch = (
      name: Parameters<typeof executeSessionAgentTool>[1],
      arguments_: Parameters<typeof executeSessionAgentTool>[2],
    ) => executeSessionAgentTool(actions, name, arguments_, deadline.signal);

    await dispatch("browse_runner_directories", {
      path: "~",
      runnerId: "runner-1",
    });
    await dispatch("get_session_options", { category: "runners" });
    await dispatch("spawn_session", {
      credentialId: "credential-1",
      executionEnvironment: "bare_metal",
      model: "model-1",
      prompt: "Delegate",
      provider: "openai",
      runnerId: "runner-1",
      tools: [],
      workingDirectory: "/work",
    });

    // The deadline signal must reach each action so discovery requests and
    // broker dispatches are canceled when the global tool time limit fires.
    expect(signals).toEqual([
      deadline.signal,
      deadline.signal,
      deadline.signal,
    ]);
  });

  test("starts no explanation model when discovery outlives the limit", () =>
    withLimitSetup(async (setup) => {
      const { detail } = setup;
      const factorySelections: unknown[] = [];
      const model = new ScriptedAgentModel([
        {
          content: "Explain the attachment.",
          toolCalls: [
            {
              arguments: '{"path":"spec.pdf"}',
              id: "explain-call",
              name: "explain_file",
            },
          ],
        },
        { content: "Finished after the timeout.", toolCalls: [] },
      ]);
      const attachment = JSON.stringify({
        data: "AQ==",
        mediaType: "application/pdf",
        name: "spec.pdf",
      });
      const broker = completingTestBroker(
        () => true,
        (tool) => (tool === "explain_file" ? attachment : "null"),
      );
      const discovery =
        Promise.withResolvers<ReturnType<typeof testAgentModelCatalog>>();
      const run = runSessionAgent({
        ...limitRuntimeOptions(setup, "Discovery deadline credential"),
        broker,
        // Discovery ignores cancellation and settles only after the limit
        // fired; the fence after the await must still drop the result.
        discoverModels: () => discovery.promise,
        modelFactory: (options) => {
          factorySelections.push(options);
          return model;
        },
      });
      await advancePastLimit();
      discovery.resolve(
        testAgentModelCatalog({
          id: detail.model,
          // Native PDF support: only the deadline fence stops the
          // explanation model from starting.
          inputModalities: ["text", "pdf"],
        }),
      );
      // Let the abandoned explanation coroutine settle before asserting
      // that it constructed no model.
      await vi.advanceTimersByTimeAsync(0);

      await expectTimedOutRunOutput(run, setup);
      // The session model loads once for the run itself; the late-settling
      // discovery must not construct a second (explanation) model.
      expect(factorySelections).toHaveLength(1);
      closeSessionTestDatabase(setup.database);
    }));
});
