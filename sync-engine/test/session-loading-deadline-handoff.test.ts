import { expect, test, vi } from "vitest";
import {
  RunnerCommandBroker,
  RunnerDisconnectedError,
} from "../../shared/runner-command-broker.ts";
import { runPersistedSession } from "../session-run.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeCompactionStore,
  requireCompactionSession,
} from "./session-compaction-test-helpers.ts";
import {
  CREDENTIAL,
  orchestrationActions,
} from "./session-restart-orchestration-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

test("loading deadline preserves a concurrent restart handoff", async () => {
  const setup = Object.assign({}, createStore());
  const detail = createTestSession(setup.store);
  const dispatched = Promise.withResolvers<undefined>();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let restartRequested = false;
  const broker = new RunnerCommandBroker();
  vi.spyOn(broker, "dispatch").mockImplementation(() => {
    restartRequested = true;
    dispatched.resolve();
    deadline.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    return Promise.reject(new RunnerDisconnectedError());
  });
  const runOptions: Parameters<typeof runPersistedSession>[0] = Object.assign(
    {
      controller: new AbortController(),
      credential: CREDENTIAL,
      detail,
      finish: () => undefined,
      notify: () => undefined,
      now: () => TEST_NOW + 17,
      operation: "agent" as const,
      resources: Object.assign(
        {},
        {
          actions: orchestrationActions(setup.database, setup.store),
          braveSearch: new (class {
            execute(): Promise<string> {
              return Promise.resolve("unused loading search result");
            }
          })(),
          broker,
          modelFactory: () => {
            throw new Error("unreached model factory");
          },
          now: () => TEST_NOW + 19,
          notify: () => void 0,
          realtime: undefined,
          store: setup.store,
        },
      ),
      restartRequest: () => {
        if (!restartRequested) return undefined;
        return {
          boundary: "handoff" as const,
          requestedBy: "runner" as const,
          restartId: "loading-restart",
        };
      },
      store: setup.store,
      userId: TEST_USER_ID,
    },
    {
      restartPersistence: Object.assign(
        {},
        {
          clear: () => void 0,
          operation: () => "agent" as const,
          persist: () => void 0,
        },
      ),
    },
  );
  const run = runPersistedSession(runOptions);
  await dispatched.promise;
  await run;

  expect(requireCompactionSession(setup.store)).toMatchObject({
    restartHandoff: { restartId: "loading-restart" },
    status: "paused",
  });
  closeCompactionStore(setup);
  vi.restoreAllMocks();
});
