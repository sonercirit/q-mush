import { expect, test } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import {
  executeSessionRealtimeCommand,
  type SessionRealtimeCommands,
} from "../../sync-engine/session-realtime-commands.ts";
import { userRealtimeCommand } from "./realtime-command-fixtures.ts";
import { TEST_REALTIME_SESSION_DETAIL } from "./realtime-session-fixture.ts";

const TEST_SESSION_DETAIL = TEST_REALTIME_SESSION_DETAIL;

const TEST_USER: AuthenticatedUser = {
  email: "mush@example.com",
  id: "user-1",
  name: "Mush",
};

function sessions(
  overrides: Partial<SessionRealtimeCommands> = {},
): SessionRealtimeCommands {
  return {
    compactForUser: () => Promise.resolve(TEST_SESSION_DETAIL),
    continueForUser: () => Promise.resolve(TEST_SESSION_DETAIL),
    createForUser: () => Promise.resolve(TEST_SESSION_DETAIL),
    readForUser: () => TEST_SESSION_DETAIL,
    summariesForUser: () => [TEST_SESSION_DETAIL],
    messageForUser: () => Promise.resolve(TEST_SESSION_DETAIL),
    modelsForUser: () =>
      Promise.resolve(Object.freeze({ defaultModel: null, models: [] })),
    setAutoCompactionForUser: () => TEST_SESSION_DETAIL,
    stopForUser: () => TEST_SESSION_DETAIL,
    ...overrides,
  };
}

test("subscribes and reads only through the authenticated owner", async () => {
  const requested: [string, string][] = [];
  const integration = sessions({
    readForUser: (userId, sessionId) => {
      requested.push([userId, sessionId]);
      return TEST_SESSION_DETAIL;
    },
  });

  const listed = await executeSessionRealtimeCommand(
    integration,
    TEST_USER,
    userRealtimeCommand(SESSION_REALTIME_OPERATIONS.subscribe, {}),
  );
  const read = await executeSessionRealtimeCommand(
    integration,
    TEST_USER,
    userRealtimeCommand(SESSION_REALTIME_OPERATIONS.read, {
      sessionId: "session-1",
    }),
  );

  expect(listed).toEqual({ sessions: [TEST_SESSION_DETAIL] });
  expect(read).toEqual({ session: TEST_SESSION_DETAIL });
  expect(requested).toEqual([[TEST_USER.id, "session-1"]]);
});

test("reports an unowned session as not found", async () => {
  await expect(
    executeSessionRealtimeCommand(
      sessions({ readForUser: () => undefined }),
      TEST_USER,
      userRealtimeCommand(SESSION_REALTIME_OPERATIONS.read, {
        sessionId: "other",
      }),
    ),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("rejects an unsupported future mutation", async () => {
  await expect(
    executeSessionRealtimeCommand(
      sessions(),
      TEST_USER,
      userRealtimeCommand("sessions.answer_question", {
        answer: "Yes",
        questionId: "question-1",
      }),
    ),
  ).rejects.toMatchObject({ code: "unsupported_operation" });
});
