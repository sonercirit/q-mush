import type { AgentModel } from "../../shared/agent-loop.ts";
import type { SessionDependencies } from "../session-dependencies.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { startToolSessionSetup } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

export interface TestLivenessClock {
  readonly advance: (milliseconds: number) => void;
  readonly connectionLost: (
    setup: ReturnType<typeof connectedSessionSetup>,
  ) => void;
  readonly dependencies: NonNullable<SessionDependencies["liveness"]>;
  readonly now: () => number;
  readonly scan: () => void;
}

export function testLivenessClock(
  graceMs: number,
  intervalMs: number,
  allowUnsafeTestTiming = false,
): TestLivenessClock {
  let current = TEST_NOW;
  let scheduled: (() => void) | undefined;
  return {
    advance: (milliseconds) => {
      current += milliseconds;
    },
    connectionLost: (setup) => {
      setup.sessions.runnerDisconnected(
        setup.sessions.listForUser(TEST_USER_ID)[0]?.runnerId ??
          "missing-runner",
      );
      const runner = setup.sessions.listForUser(TEST_USER_ID)[0];
      if (runner !== undefined) {
        setup.runners.disconnected({
          id: runner.runnerId,
          userId: TEST_USER_ID,
        });
      }
    },
    dependencies: {
      ...(allowUnsafeTestTiming ? { allowUnsafeTestTiming: true } : {}),
      graceMs,
      intervalMs,
      setInterval: (callback) => {
        scheduled = callback;
        return 1;
      },
    },
    now: () => current,
    scan: () => {
      if (scheduled === undefined) {
        throw new Error("The liveness scan was not scheduled");
      }
      scheduled();
    },
  };
}

async function createRunningLivenessSession(
  model: AgentModel,
  clock: TestLivenessClock,
) {
  const setup = connectedSessionSetup(model, "api_key", undefined, {
    liveness: clock.dependencies,
    now: clock.now,
  });
  await startToolSessionSetup(setup);
  return setup;
}

export async function createUnsafeLivenessSession(model: AgentModel) {
  const clock = testLivenessClock(1_000, 100, true);
  return {
    clock,
    setup: await createRunningLivenessSession(model, clock),
  };
}

// The queued compaction relaunches the agent, which re-reads the agent
// file before the model call; complete that runner command, then wait for
// the compacted (older-segments) shape.
export function waitForCompactedSession(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<unknown> {
  const olderSegments = () =>
    setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.hasOlderSegments;
  return completeAgentFileLookup(setup).then(() =>
    waitForSessionValue(olderSegments, (value) => value === true),
  );
}

export async function waitForIdleSession(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<void> {
  await waitForSessionValue(
    () => setup.sessions.listForUser(TEST_USER_ID)[0]?.status,
    (status) => status === "idle",
  );
}

export function sessionDetailStatus(
  setup: Pick<ReturnType<typeof connectedSessionSetup>, "sessions">,
  sessionId?: string,
) {
  return sessionId === undefined
    ? setup.sessions.listForUser(TEST_USER_ID)[0]?.status
    : setup.sessions.detailForUser(TEST_USER_ID, sessionId)?.status;
}

export function closeLivenessSession(
  setup: Pick<ReturnType<typeof connectedSessionSetup>, "database">,
): void {
  setup.database.$client.close();
}

export async function awaitProviderCall(
  requests: readonly unknown[],
): Promise<void> {
  await waitForSessionValue(
    () => requests.length,
    (count) => count === 1,
  );
}

export function scanAfter(
  clock: TestLivenessClock,
  milliseconds: number,
): void {
  clock.scan();
  clock.advance(milliseconds);
  clock.scan();
}
