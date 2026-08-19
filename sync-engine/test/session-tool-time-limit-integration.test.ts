import { describe, expect, test, vi } from "vitest";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  toolExecutionLimitMilliseconds,
} from "../../shared/tool-limits.ts";
import { runSessionAgent } from "../session-agent-runtime.ts";
import { executeSessionAgentTool } from "../session-agent-tools.ts";
import { SessionFinisher } from "../session-finisher.ts";
import { runPersistedSession } from "../session-run.ts";
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
import { orchestrationActions } from "./session-restart-orchestration-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

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
  fakeTimers = true,
): Promise<void> {
  if (fakeTimers) vi.useFakeTimers();
  try {
    const setup = runningCompactionStore();
    const detail = requireCompactionSession(setup.store);
    await run({ database: setup.database, detail, store: setup.store });
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
}

async function advancePastLimit(dispatched: Promise<void>): Promise<void> {
  // Never move the fake clock until the runner has observably received the
  // actual tool call and its per-call deadline timer therefore exists.
  await dispatched;
  await vi.advanceTimersByTimeAsync(
    toolExecutionLimitMilliseconds(DEFAULT_TOOL_SETTINGS),
  );
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
  expect(outputs[0]).toContain(
    `${String(DEFAULT_TOOL_SETTINGS.executionLimitMinutes)}-minute limit`,
  );
}

function resolveOnTool(
  expectedTool: string,
  dispatched: { readonly resolve: (value?: undefined) => void },
): (tool: string) => void {
  return (tool) => {
    if (tool === expectedTool) dispatched.resolve();
  };
}

function observedBroker(options: {
  readonly completes: (tool: string) => boolean;
  readonly output?: (tool: string) => string;
  readonly tool: string;
}): {
  readonly broker: ReturnType<typeof completingTestBroker>;
  readonly dispatched: Promise<void>;
} {
  const dispatched = Promise.withResolvers<undefined>();
  return {
    broker: completingTestBroker(
      options.completes,
      options.output,
      resolveOnTool(options.tool, dispatched),
    ),
    dispatched: dispatched.promise,
  };
}

function persistedDeadlineRun(
  setup: LimitSetup,
  broker: RunnerCommandBroker,
  controller: AbortController,
  factorySelections: unknown[],
  finishedErrors: unknown[],
): Promise<void> {
  const actions = Object.assign(
    orchestrationActions(setup.database, setup.store),
    {},
  );
  const finisherOptions = {
    actions,
    notify: () => undefined,
    now: () => TEST_NOW + 4,
    store: setup.store,
  };
  const finisher = new SessionFinisher(finisherOptions);
  return runPersistedSession({
    controller,
    credential: runtimeTestCredential(
      setup.detail.credentialId,
      "Agent file deadline credential",
    ),
    detail: setup.detail,
    finish: (detail, userId, error, recovered) => {
      finishedErrors.push(error);
      finisher.finish(detail, userId, error, recovered);
    },
    notify: () => undefined,
    now: () => TEST_NOW + 3,
    operation: "agent",
    resources: Object.assign(
      {},
      {
        actions,
        braveSearch: Object.assign(
          {},
          {
            execute: () => Promise.resolve("unused search result"),
          },
        ),
        broker,
        modelFactory: (
          options: Parameters<
            Parameters<
              typeof runPersistedSession
            >[0]["resources"]["modelFactory"]
          >[0],
        ) => {
          factorySelections.push(options);
          return Object.assign(new ScriptedAgentModel([]), {});
        },
        notify: () => undefined,
        realtime: undefined,
        now: () => TEST_NOW + 3,
        store: setup.store,
      },
    ),
    restartPersistence: Object.assign(
      {},
      {
        clear: () => undefined,
        operation: () => "agent" as const,
        persist: () => undefined,
      },
    ),
    restartRequest: () => undefined,
    store: setup.store,
    userId: TEST_USER_ID,
  });
}

describe("global tool time limit integration", () => {
  test("aborts agent-file loading at the limit before starting a model", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = createStore();
    createTestSession(created.store);
    const setup = {
      database: created.database,
      detail: requireCompactionSession(created.store),
      store: created.store,
    };
    try {
      const dispatched = Promise.withResolvers<undefined>();
      const canceled = Promise.withResolvers<string>();
      const finishedErrors: unknown[] = [];
      const factorySelections: unknown[] = [];
      const deadline = AbortSignal.timeout(60);
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline);
      const broker = new RunnerCommandBroker({
        cancel: (_runnerId, commandId) => {
          canceled.resolve(commandId);
        },
        commandId: () => "loading-command",
        deliver: (_runnerId, command) => {
          expect(command.tool).toBe("read_agent_file");
          dispatched.resolve();
          return true;
        },
      });
      const controller = new AbortController();
      const run = persistedDeadlineRun(
        setup,
        broker,
        controller,
        factorySelections,
        finishedErrors,
      );
      await dispatched.promise;
      await vi.waitFor(() => {
        expect(deadline.aborted).toBe(true);
      });
      expect(deadline).toMatchObject({
        aborted: true,
        reason: { name: "TimeoutError" },
      });
      await run;
      await expect(canceled.promise).resolves.toBe("loading-command");
      expect(finishedErrors).toHaveLength(1);
      const finishedError = finishedErrors[0];
      expect(finishedError).toBeInstanceOf(Error);
      if (!(finishedError instanceof Error)) throw new Error("Expected error");
      expect(finishedError).toMatchObject({ name: "TimeoutError" });
      expect(finishedError.cause).toBe(deadline.reason);
      expect(finishedError.message).toContain("global 30-minute limit");
      expect(setup.store.get(TEST_USER_ID, setup.detail.id)).toMatchObject({
        status: "failed",
      });
      const failureMessage = setup.store
        .get(TEST_USER_ID, setup.detail.id)
        ?.messages.find(({ role }) => role === "error");
      expect(failureMessage?.content).toContain("global 30-minute limit");
      expect(controller.signal.aborted).toBe(false);
      expect(factorySelections).toHaveLength(0);
      closeSessionTestDatabase(setup.database);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

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
      const { broker, dispatched } = observedBroker({
        completes: (tool) => tool === "read_agent_file",
        tool: "read",
      });
      const run = runSessionAgent({
        ...limitRuntimeOptions(setup, "Time limit credential"),
        broker,
        modelFactory: () => model,
      });
      await advancePastLimit(dispatched);

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
      reassignSession: (_sessionId, _runnerId, _directory, signal) => {
        void record(signal);
        return "recorded";
      },
      spawnSession: (_input, signal) => record(signal),
      steerSession: (_sessionId, _message, signal) => record(signal),
      stopSession: (_sessionId, _cascade, signal) => {
        void record(signal);
        return "recorded";
      },
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
    await dispatch("reassign_session", {
      runnerId: "runner-1",
      sessionId: "session-1",
      workingDirectory: "/work",
    });
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
    await dispatch("steer_session", {
      message: "Change course",
      sessionId: "session-1",
    });
    await dispatch("stop_session", { sessionId: "session-1" });

    // The deadline signal must reach each action so discovery requests and
    // broker dispatches are canceled when the global tool time limit fires.
    expect(signals).toHaveLength(6);
    expect(signals.every((signal) => signal === deadline.signal)).toBe(true);
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
      const { broker, dispatched } = observedBroker({
        completes: () => true,
        output: (tool) => (tool === "explain_file" ? attachment : "null"),
        tool: "explain_file",
      });
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
      await advancePastLimit(dispatched);
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
