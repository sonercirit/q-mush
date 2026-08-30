import { expect, test, vi } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { RUNNER_REALTIME_PATH, RUNNERS_PATH } from "../../shared/routes.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { GLOBAL_WORKSPACE_ID } from "../../shared/workspace-model.ts";
import type { GoogleAuth } from "../../sync-engine/auth.ts";
import { createRealtimeHub } from "../../sync-engine/realtime-hub.ts";
import type {
  createRealtimeIntegration,
  QmushWebSocketData,
} from "../../sync-engine/realtime.ts";
import { createRunnerStore } from "../../sync-engine/runner-store.ts";
import { createRunnerIntegration } from "../../sync-engine/runners.ts";
import { TEST_PENDING_QUESTIONS } from "./ask-questions-test-fixtures.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { createSessionRealtimeCommandPayload } from "./realtime-command-fixtures.ts";
import {
  REALTIME_TEST_SESSION_DETAIL,
  realtimeTestSessionCommands,
} from "./realtime-session-fixture.ts";
import {
  configuredRealtimeTestIntegration,
  connectedRunnerRealtimeTestIntegration,
  createRealtimeTestIntegration,
  createRealtimeUpgradeServer,
  REALTIME_TEST_USER,
  realtimeRunnerConnection,
  realtimeTestAuth,
  realtimeTestSessions,
  type RealtimeRunnerOverrides,
  type RealtimeSessionOverrides,
} from "./realtime-test-helpers.ts";
import {
  assertRealtimeUpgrade,
  connectedRecordedRunnerRealtimeTestSocket,
  openRealtimeSocket,
  openUserRealtimeTestSocket,
  parseRealtimeMessages,
  realtimeTestSocket,
  realtimeTestUpgrade,
  recordedRealtimeTestSocket,
  sendRealtimeMessage,
  sendUserRealtimeCommand,
  waitForRealtimeEvent,
} from "./realtime-test-socket-helpers.ts";
import { runnerMetadata } from "./runner-integration-test-helpers.ts";

const USER = REALTIME_TEST_USER;

function authSequence(...users: (AuthenticatedUser | null)[]): GoogleAuth {
  let index = 0;
  const revalidateUser: GoogleAuth["revalidateUser"] = (
    _request,
    expectedUserId,
  ) => {
    const selectedIndex = Math.min(index, users.length - 1);
    index += 1;
    const user = users[selectedIndex] ?? null;
    if (user?.id !== expectedUserId) {
      return null;
    }
    return user;
  };
  return { ...realtimeTestAuth(users[0] ?? null), revalidateUser };
}

function integrationWithAuth(
  selectedAuth: GoogleAuth,
  token?: string,
  runnerOverrides?: RealtimeRunnerOverrides,
  sessionOverrides?: RealtimeSessionOverrides,
) {
  return createRealtimeTestIntegration(selectedAuth, {
    ...(runnerOverrides === undefined ? {} : { runnerOverrides }),
    ...(sessionOverrides === undefined ? {} : { sessionOverrides }),
    ...(token === undefined ? {} : { token }),
  });
}

function integration(
  user: AuthenticatedUser | null,
  token?: string,
  runnerOverrides?: RealtimeRunnerOverrides,
  sessionOverrides?: RealtimeSessionOverrides,
) {
  return integrationWithAuth(
    realtimeTestAuth(user),
    token,
    runnerOverrides,
    sessionOverrides,
  );
}

function userCommandConnection(selectedAuth: GoogleAuth) {
  const realtime = integrationWithAuth(selectedAuth);
  return { connection: openUserRealtimeTestSocket(realtime), realtime };
}

function openedSessionPublisher(
  detail: () => AgentSessionDetail,
  sessionOverrides: RealtimeSessionOverrides = {},
) {
  let listener: ((userId: string, sessionId: string) => void) | undefined;
  const realtime = configuredRealtimeTestIntegration({
    auth: realtimeTestAuth(USER),
    hub: createRealtimeHub(),
    sessions: realtimeTestSessions({
      detailForUser: detail,
      listForUser: () => [detail()],
      onChanges: (nextListener) => {
        listener = (userId, sessionId) => {
          nextListener(userId, [sessionId]);
        };
      },
      ...sessionOverrides,
    }),
  });
  return {
    connection: openUserRealtimeTestSocket(realtime),
    publish: () => {
      const selected = detail();
      listener?.(USER.id, selected.id);
    },
  };
}

function sessionPublicationEvents(detail: AgentSessionDetail) {
  return [
    { session: detail, type: "session" },
    { pending: null, sessionId: detail.id, type: "session_questions" },
    { sessions: [detail], type: "sessions" },
  ];
}

function expectUpgrade(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  path: string,
  expected: QmushWebSocketData,
): void {
  expect(assertRealtimeUpgrade(realtime, path)).toEqual(expected);
}

test("upgrades an authenticated browser request", () => {
  const server = createRealtimeUpgradeServer();
  expect(
    realtimeTestUpgrade(integration(USER), "/api/realtime", server),
  ).toBeUndefined();
  expect(server.data).toMatchObject({ kind: "user", user: USER });
  expect(server.data).toHaveProperty("request");
});

test("rejects invalid browser scopes", () => {
  const realtime = configuredRealtimeTestIntegration({
    auth: realtimeTestAuth(USER),
    workspaceExists: (_userId, workspaceId) =>
      workspaceId !== GLOBAL_WORKSPACE_ID && workspaceId === "workspace-1",
  });

  const server = createRealtimeUpgradeServer();

  for (const path of [
    "/api/realtime?",
    `/api/realtime?workspaceId=${GLOBAL_WORKSPACE_ID}`,
  ]) {
    expect(realtimeTestUpgrade(realtime, path, server)?.status).toBe(401);
  }

  expect(
    realtimeTestUpgrade(
      realtime,
      "/api/realtime?workspaceId=workspace-1",
      server,
    ),
  ).toBeUndefined();
});

test("requires a same-origin browser request", () => {
  const realtime = integration(USER);
  const server = createRealtimeUpgradeServer();
  const request = (origin?: string) =>
    new Request("http://localhost/api/realtime?workspaceId=workspace-1", {
      headers: {
        ...(origin === undefined ? {} : { origin }),
        upgrade: "websocket",
      },
    });

  expect(realtime.upgrade(request(), server)?.status).toBe(403);
  expect(
    realtime.upgrade(request("https://other.example"), server)?.status,
  ).toBe(403);
  expect(realtime.upgrade(request("http://localhost"), server)).toBeUndefined();
});

test("rejects invalid realtime requests", () => {
  const server = createRealtimeUpgradeServer();
  const unauthorized = realtimeTestUpgrade(
    integration(null),
    "/api/realtime",
    server,
  );
  const missingUpgrade = realtimeTestUpgrade(
    integration(USER),
    "/api/realtime",
    server,
    false,
  );

  expect(unauthorized?.status).toBe(401);
  expect(missingUpgrade?.status).toBe(426);
});

test.each(["zero", "throw"] as const)(
  "closes when browser snapshot delivery returns %s",
  (failure) => {
    const realtime = integration(USER);
    const server = createRealtimeUpgradeServer();
    expect(
      realtimeTestUpgrade(realtime, "/api/realtime", server),
    ).toBeUndefined();
    const connection = recordedRealtimeTestSocket(server.data, {
      failure,
      successfulSendsBeforeFailure: 1,
    });

    openRealtimeSocket(realtime.websocket, connection.socket);

    expect(connection.record.closed).toEqual([
      1011,
      "Realtime snapshot failed",
    ]);
  },
);

const invalidCommand = Object.freeze({
  commandId: "command-invalid",
  idempotencyKey: "invalid-1",
  operation: "bad operation",
  payload: {},
  type: "command",
});

test("acknowledges malformed browser commands", () => {
  const realtime = integration(USER);
  const socket = realtimeTestSocket(
    assertRealtimeUpgrade(realtime, "/api/realtime"),
  );

  sendRealtimeMessage(realtime.websocket, socket, invalidCommand);

  expect(parseRealtimeMessages(socket.sent)).toContainEqual({
    commandId: "command-invalid",
    error: "invalid_command",
    type: "command_error",
  });
});

function expectExpiredRealtimeConnection(
  connection: ReturnType<typeof openUserRealtimeTestSocket>,
): void {
  expect(connection.record.sent).toEqual([]);
  expect(connection.record.closed).toEqual([1008, "Authentication expired"]);
}

test("revalidates authentication for malformed commands", () => {
  const realtime = integrationWithAuth(authSequence(USER, null));
  const connection = openUserRealtimeTestSocket(realtime);

  sendRealtimeMessage(realtime.websocket, connection.socket, invalidCommand);

  expectExpiredRealtimeConnection(connection);
});

test("rejects commands after authentication expires", async () => {
  const { connection: expired, realtime } = userCommandConnection(
    authSequence(USER, USER, null),
  );

  sendUserRealtimeCommand(realtime.websocket, expired.socket, [
    SESSION_REALTIME_OPERATIONS.read,
    { sessionId: "session-1" },
    { commandId: "command-expired", idempotencyKey: "expired-1" },
  ]);
  await waitForRealtimeEvent(expired.record.sent, "command_error");

  expect(parseRealtimeMessages(expired.record.sent)).toContainEqual({
    commandId: "command-expired",
    error: "authentication_expired",
    type: "command_error",
  });
});

test("executes authenticated browser commands", async () => {
  const { connection, realtime } = userCommandConnection(
    realtimeTestAuth(USER),
  );

  sendUserRealtimeCommand(realtime.websocket, connection.socket, [
    SESSION_REALTIME_OPERATIONS.read,
    { sessionId: "session-1" },
    { commandId: "command-1", idempotencyKey: "read-1" },
  ]);
  await waitForRealtimeEvent(connection.record.sent, "command_success");

  expect(parseRealtimeMessages(connection.record.sent)).toContainEqual({
    commandId: "command-1",
    result: REALTIME_TEST_SESSION_DETAIL,
    type: "command_success",
  });
});

test("does not replay a retained command result across workspaces", async () => {
  const createForUser = vi.fn((_user, _input, workspaceId: string) =>
    Promise.resolve({ ...REALTIME_TEST_SESSION_DETAIL, workspaceId }),
  );
  const realtime = configuredRealtimeTestIntegration({
    auth: realtimeTestAuth(USER),
    sessions: realtimeTestSessions({
      realtimeCommands: realtimeTestSessionCommands({ createForUser }),
    }),
  });
  const first = recordedRealtimeTestSocket(
    assertRealtimeUpgrade(realtime, "/api/realtime?workspaceId=workspace-a"),
    { failure: "zero" },
  );
  const retry = recordedRealtimeTestSocket(
    assertRealtimeUpgrade(realtime, "/api/realtime?workspaceId=workspace-b"),
  );
  const identifiers = {
    commandId: "create-command-1",
    idempotencyKey: "create-request-1",
  };
  sendUserRealtimeCommand(realtime.websocket, first.socket, [
    SESSION_REALTIME_OPERATIONS.create,
    createSessionRealtimeCommandPayload(),
    identifiers,
  ]);
  await vi.waitFor(() => {
    expect(first.record.closed).toEqual([
      1011,
      "Realtime acknowledgement failed",
    ]);
  });
  expect(first.record.sent).toEqual([]);

  sendUserRealtimeCommand(realtime.websocket, retry.socket, [
    SESSION_REALTIME_OPERATIONS.create,
    createSessionRealtimeCommandPayload(),
    { ...identifiers, commandId: "create-command-2" },
  ]);
  await waitForRealtimeEvent(retry.record.sent, "command_success");

  expect(
    parseRealtimeMessages(retry.record.sent).find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "type") === "command_success",
    ),
  ).toMatchObject({
    commandId: "create-command-2",
    result: { workspaceId: "workspace-b" },
  });
  expect(createForUser).toHaveBeenCalledTimes(2);
  expect(createForUser.mock.calls.map((call) => call[2])).toEqual([
    "workspace-a",
    "workspace-b",
  ]);
});

test("restores owned active tool streams", () => {
  const hub = createRealtimeHub();
  const reads: unknown[] = [];
  hub.publishToolStream(
    USER.id,
    {
      callId: "call-reconnect",
      index: 0,
      sequence: 0,
      sessionId: "session-1",
      state: "preparing",
      streamId: "stream-reconnect",
      type: "tool_stream",
    },
    "workspace-1",
  );
  const realtime = configuredRealtimeTestIntegration({
    auth: realtimeTestAuth(USER),
    hub,
    sessions: realtimeTestSessions({
      detailForUser: (userId, sessionId, workspaceId) => {
        reads.push({ sessionId, userId, workspaceId });
        return REALTIME_TEST_SESSION_DETAIL;
      },
    }),
  });

  const connection = openUserRealtimeTestSocket(realtime);
  const syncRequest = {
    sessionId: "session-1",
    streamId: "stream-reconnect",
    type: "sync_tools" as const,
  };
  sendRealtimeMessage(realtime.websocket, connection.socket, syncRequest);

  expect(reads).toEqual([
    {
      sessionId: "session-1",
      userId: USER.id,
      workspaceId: "workspace-1",
    },
  ]);
  expect(parseRealtimeMessages(connection.record.sent)).toEqual([
    {
      sessionId: "session-1",
      streamId: "stream-reconnect",
      streams: [
        {
          arguments: "",
          callId: "call-reconnect",
          index: 0,
          name: "",
          sequence: 0,
          sessionId: "session-1",
          state: "preparing",
          stderr: "",
          stdout: "",
          streamId: "stream-reconnect",
        },
      ],
      type: "tool_stream_snapshot",
    },
  ]);
});

test("wakes completed child callbacks on connect", () => {
  const connectedUsers: string[] = [];
  const realtime = connectedRunnerRealtimeTestIntegration(
    {
      runnerConnected: (runnerId) => {
        connectedUsers.push(`${USER.id}:${runnerId}`);
      },
    },
    {
      connect: () => {
        const connected = realtimeRunnerConnection();
        return {
          ...connected,
          connection: { ...connected.connection, tokenHash: "hash" },
        };
      },
    },
  );
  connectedRecordedRunnerRealtimeTestSocket(realtime, "machine-1");

  expect(connectedUsers).toEqual([`${USER.id}:runner-1`]);
});

test("runner removal closes its socket, publishes the list, and responds before cleanup settles", async () => {
  const { auth, database } = createAuthenticatedTestContext();
  const runnerId = "018bcfe5-6800-7000-8000-000000000074";
  const token = "qmr_runner-removal-token";
  const runners = createRunnerIntegration(auth, {
    now: () => TEST_NOW,
    randomToken: () => "runner-removal-token",
    store: createRunnerStore(database, () => runnerId),
  });
  const created = runners.collection(
    createAuthenticatedRequest(RUNNERS_PATH, undefined, "POST"),
  );
  expect(created.status).toBe(201);
  const connected = runners.connect(
    token,
    runnerMetadata("runner-removal-machine"),
  );
  expect(connected).toBeDefined();
  if (connected === undefined) {
    throw new Error("The removal test runner did not connect");
  }

  const hub = createRealtimeHub();
  const realtime = configuredRealtimeTestIntegration({
    auth: realtimeTestAuth({ ...USER, id: TEST_USER_ID }),
    hub,
    runners,
  });
  const browser = openUserRealtimeTestSocket(realtime);
  const runner = recordedRealtimeTestSocket({
    committed: undefined,
    fenced: false,
    kind: "runner",
    registration: undefined,
    runner: connected.connection,
    token,
    usable: true,
  });
  hub.setRunner(runnerId, runner.socket, true);

  const cleanup = Promise.withResolvers<undefined>();
  let responseSettled = false;
  let cleanupStartedAfterResponse: boolean | undefined;
  runners.onRemoved(async () => {
    cleanupStartedAfterResponse = responseSettled;
    await cleanup.promise;
  });
  const removal = runners.remove(
    createAuthenticatedRequest(
      `${RUNNERS_PATH}/${runnerId}`,
      undefined,
      "DELETE",
    ),
    runnerId,
  );
  const promptResponse = await Promise.race([
    removal,
    new Promise<undefined>((resolve) => {
      setTimeout(resolve, 100);
    }),
  ]);
  cleanup.resolve();
  const response = await removal;
  responseSettled = true;
  await Bun.sleep(10);

  expect(promptResponse).toBe(response);
  expect(cleanupStartedAfterResponse).toBe(true);
  expect(response.status).toBe(204);
  expect(runner.record.closed).toEqual([1000, "Runner removed"]);
  expect(parseRealtimeMessages(browser.record.sent)).toEqual([
    { runners: [], type: "runners" },
  ]);
  database.$client.close();
});

test("publishes and clears pending questions", () => {
  const pending = TEST_PENDING_QUESTIONS;
  let current: typeof pending | null = pending;
  const detail: AgentSessionDetail = {
    ...REALTIME_TEST_SESSION_DETAIL,
    pendingQuestions: pending,
    status: "paused",
  };

  const { connection, publish } = openedSessionPublisher(() => detail, {
    pendingQuestionForUser: () => current,
  });

  publish();
  current = null;
  publish();

  expect(
    parseRealtimeMessages(connection.record.sent).filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        Reflect.get(event, "type") === "session_questions",
    ),
  ).toEqual([
    { pending, sessionId: detail.id, type: "session_questions" },
    { pending: null, sessionId: detail.id, type: "session_questions" },
  ]);
});

test("publishes reassigned session snapshots", () => {
  let detail: AgentSessionDetail = {
    ...REALTIME_TEST_SESSION_DETAIL,
    id: "session-1",
    runnerId: "removed-runner",
    runnerRequired: true,
    status: "idle",
  };

  const initial = detail;
  const { connection, publish } = openedSessionPublisher(() => detail);

  publish();
  detail = {
    ...detail,
    runnerId: "replacement-runner",
    runnerRequired: false,
    workingDirectory: "/replacement/project",
  };

  publish();

  expect(parseRealtimeMessages(connection.record.sent)).toEqual([
    ...sessionPublicationEvents(initial),
    ...sessionPublicationEvents(detail),
  ]);
});

test("upgrades a token-authenticated runner request", () => {
  expectUpgrade(integration(null, "qmr_runner-token"), RUNNER_REALTIME_PATH, {
    committed: undefined,
    fenced: false,
    kind: "runner",
    registration: undefined,
    runner: undefined,
    token: "qmr_runner-token",
    usable: false,
  });
});
