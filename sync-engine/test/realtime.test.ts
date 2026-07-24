import { expect, test } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { RUNNER_REALTIME_PATH } from "../../shared/routes.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { GoogleAuth } from "../../sync-engine/auth.ts";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import {
  createRealtimeIntegration,
  type QmushWebSocketData,
} from "../../sync-engine/realtime.ts";
import type { RunnerIntegration } from "../../sync-engine/runners.ts";
import type { SessionIntegration } from "../../sync-engine/sessions.ts";
import { REALTIME_TEST_SESSION_DETAIL } from "./realtime-session-fixture.ts";

const USER: AuthenticatedUser = {
  email: "mush@example.com",
  id: "user-1",
  name: "Mush",
  picture: "https://example.test/avatar.png",
};

class UpgradeServer {
  data: QmushWebSocketData | undefined;

  upgrade(
    _request: Request,
    options: { readonly data: QmushWebSocketData },
  ): boolean {
    this.data = options.data;
    return true;
  }
}

function auth(user: AuthenticatedUser | null): GoogleAuth {
  return {
    authenticatedUser: () => user,
    begin: () => new Response(),
    complete: () => Promise.resolve(new Response()),
    logout: () => new Response(),
    session: () => new Response(),
  };
}

type RunnerIntegrationOverrides = Partial<
  Pick<RunnerIntegration, "connect" | "runnerToken" | "seen">
>;

function runners(
  token: string | undefined,
  overrides: RunnerIntegrationOverrides = {},
): RunnerIntegration {
  return {
    collection: () => new Response(),
    connect: () => undefined,
    disconnected: () => undefined,
    installer: () => new Response(),
    listForUser: () => [],
    listOnlineForUser: () => ({ items: [], totalItems: 0 }),
    onRemoved: () => undefined,
    onRemoving: () => undefined,
    onlineForUser: () => [],
    remove: () => Promise.resolve(new Response()),
    runnerIsAvailable: () => false,
    runnerToken: () => token,
    seen: () => undefined,
    setDefault: () => new Response(),
    ...overrides,
  };
}

type SessionIntegrationOverrides = Partial<
  Pick<
    SessionIntegration,
    "detailForUser" | "listForUser" | "onChange" | "runnerConnected"
  >
>;

function sessions(
  overrides: SessionIntegrationOverrides = {},
): SessionIntegration {
  return {
    collection: () => Promise.resolve(new Response()),
    compact: () => Promise.resolve(new Response()),
    compaction: () => Promise.resolve(new Response()),
    completeRunnerCommand: () => false,
    continue: () => Promise.resolve(new Response()),
    deliverRunnerCommands: () => undefined,
    detailForUser: () => undefined,
    directories: () => Promise.resolve(new Response()),
    drain: () => Promise.resolve(),
    item: () => new Response(),
    listForUser: () => [],
    message: () => Promise.resolve(new Response()),
    models: () => Promise.resolve(new Response()),
    onChange: () => undefined,
    reassign: () => Promise.resolve(new Response()),
    runnerConnected: () => undefined,
    runnerRemoved: () => Promise.resolve(),
    stop: () => Promise.resolve(new Response()),
    ...overrides,
  };
}

function integration(
  user: AuthenticatedUser | null,
  token?: string,
  runnerOverrides?: RunnerIntegrationOverrides,
  sessionOverrides?: SessionIntegrationOverrides,
) {
  return createRealtimeIntegration({
    auth: auth(user),
    hub: new RealtimeHub(),
    runnerVersion: "runner-version",
    runners: runners(token, runnerOverrides),
    sessions: sessions(sessionOverrides),
  });
}

function upgrade(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  path: string,
  server: UpgradeServer,
  websocket = true,
): Response | undefined {
  return realtime.upgrade(
    new Request(`http://localhost${path}`, {
      ...(websocket ? { headers: { upgrade: "websocket" } } : {}),
    }),
    server,
  );
}

interface TestSocket {
  readonly data: QmushWebSocketData;
  close(): void;
  publish(): number;
  send(): number;
  subscribe(): void;
  unsubscribe(): void;
}

function testSocket(data: QmushWebSocketData | undefined): TestSocket {
  if (data === undefined) {
    throw new Error("The test WebSocket did not upgrade");
  }
  return {
    close: () => undefined,
    data,
    publish: () => 1,
    send: () => 1,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  };
}

function websocketMessage(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: TestSocket,
  message: string,
): unknown {
  const method: unknown = Reflect.get(handler, "message");
  if (typeof method !== "function") {
    throw new TypeError("The realtime message handler is unavailable");
  }
  return Reflect.apply(method, undefined, [socket, message]);
}

function expectUpgrade(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  path: string,
  expected: QmushWebSocketData,
): void {
  const server = new UpgradeServer();
  expect(upgrade(realtime, path, server)).toBeUndefined();
  expect(server.data).toEqual(expected);
}

test("upgrades an authenticated browser realtime request", () => {
  expectUpgrade(integration(USER), "/api/realtime", {
    kind: "user",
    user: USER,
  });
});

test("rejects unauthorized and non-WebSocket realtime requests", () => {
  const server = new UpgradeServer();
  const unauthorized = upgrade(integration(null), "/api/realtime", server);
  const missingUpgrade = upgrade(
    integration(USER),
    "/api/realtime",
    server,
    false,
  );

  expect(unauthorized?.status).toBe(401);
  expect(missingUpgrade?.status).toBe(426);
});

test("recovers and wakes completed child callbacks when a runner connects", () => {
  const connectedUsers: string[] = [];
  const realtime = integration(
    null,
    "qmr_runner-token",
    {
      connect: () => ({
        connection: {
          id: "runner-1",
          tokenHash: "hash",
          userId: USER.id,
        },
        userId: USER.id,
      }),
    },
    {
      runnerConnected: () => {
        connectedUsers.push(USER.id);
      },
    },
  );
  const server = new UpgradeServer();
  expect(upgrade(realtime, RUNNER_REALTIME_PATH, server)).toBeUndefined();
  const socket = testSocket(server.data);

  void websocketMessage(
    realtime.websocket,
    socket,
    JSON.stringify({
      architecture: "x64",
      machineId: "machine-1",
      name: "runner",
      platform: "linux",
      type: "connect",
    }),
  );

  expect(connectedUsers).toEqual([USER.id]);
});
test("publishes runner-required and reassigned session snapshots", () => {
  const hub = new RealtimeHub();
  const sent: string[] = [];
  let listener: ((userId: string, sessionId: string) => void) | undefined;
  let detail: AgentSessionDetail = {
    ...REALTIME_TEST_SESSION_DETAIL,
    id: "session-1",
    runnerId: "removed-runner",
    runnerRequired: true,
    status: "idle",
  };
  const realtime = createRealtimeIntegration({
    auth: auth(USER),
    hub,
    runnerVersion: "runner-version",
    runners: runners(undefined),
    sessions: sessions({
      detailForUser: () => detail,
      listForUser: () => [detail],
      onChange: (nextListener) => {
        listener = nextListener;
      },
    }),
  });
  const server = new UpgradeServer();
  expect(upgrade(realtime, "/api/realtime", server)).toBeUndefined();
  const socket = {
    ...testSocket(server.data),
    send(message: string): number {
      sent.push(message);
      return 1;
    },
  };
  const open: unknown = Reflect.get(realtime.websocket, "open");
  if (typeof open !== "function") {
    throw new TypeError("The realtime open handler is unavailable");
  }
  Reflect.apply(open, undefined, [socket]);
  sent.length = 0;

  listener?.(USER.id, detail.id);
  detail = {
    ...detail,
    runnerId: "replacement-runner",
    runnerRequired: false,
    workingDirectory: "/replacement/project",
  };
  listener?.(USER.id, detail.id);

  const events: unknown[] = sent.map((message) => {
    const event: unknown = JSON.parse(message);
    return event;
  });
  expect(events).toEqual([
    {
      session: {
        ...REALTIME_TEST_SESSION_DETAIL,
        runnerId: "removed-runner",
        runnerRequired: true,
      },
      type: "session",
    },
    {
      sessions: [
        {
          ...REALTIME_TEST_SESSION_DETAIL,
          runnerId: "removed-runner",
          runnerRequired: true,
        },
      ],
      type: "sessions",
    },
    { session: detail, type: "session" },
    { sessions: [detail], type: "sessions" },
  ]);
});

test("upgrades a token-authenticated runner realtime request", () => {
  expectUpgrade(integration(null, "qmr_runner-token"), RUNNER_REALTIME_PATH, {
    kind: "runner",
    runner: undefined,
    token: "qmr_runner-token",
  });
});
