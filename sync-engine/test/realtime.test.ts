import { expect, test } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { RUNNER_REALTIME_PATH } from "../../shared/routes.ts";
import type { GoogleAuth } from "../../sync-engine/auth.ts";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import {
  createRealtimeIntegration,
  type QmushWebSocketData,
} from "../../sync-engine/realtime.ts";
import type { RunnerIntegration } from "../../sync-engine/runners.ts";
import type { SessionIntegration } from "../../sync-engine/sessions.ts";

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
    remove: () => new Response(),
    runnerIsAvailable: () => false,
    runnerToken: () => token,
    seen: () => undefined,
    setDefault: () => new Response(),
    ...overrides,
  };
}

function sessions(
  overrides: Partial<
    Pick<SessionIntegration, "drainRunner" | "runnerConnected">
  > = {},
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
    drainRunner: () => Promise.resolve(),
    item: () => new Response(),
    listForUser: () => [],
    message: () => Promise.resolve(new Response()),
    models: () => Promise.resolve(new Response()),
    onChange: () => undefined,
    recover: () => undefined,
    runnerConnected: () => undefined,
    stop: () => Promise.resolve(new Response()),
    ...overrides,
  };
}

function integration(
  user: AuthenticatedUser | null,
  token?: string,
  runnerOverrides?: RunnerIntegrationOverrides,
  sessionOverrides?: Partial<
    Pick<SessionIntegration, "drainRunner" | "runnerConnected">
  >,
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
  readonly sent: string[];
  close(): void;
  publish(): number;
  send(message?: string): number;
  subscribe(): void;
  unsubscribe(): void;
}

function testSocket(data: QmushWebSocketData | undefined): TestSocket {
  if (data === undefined) {
    throw new Error("The test WebSocket did not upgrade");
  }
  const socket: TestSocket = {
    // cpd-ignore-start -- The close stub mirrors the production socket cleanup contract.
    close: () => {
      if (socket.data.kind === "runner") {
        socket.data.restart = undefined;
      }
    },
    // cpd-ignore-end
    data,
    publish: () => 1,
    send: (message) => {
      if (message !== undefined) {
        socket.sent.push(message);
      }
      return 1;
    },
    sent: [],
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  };
  return socket;
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
  // cpd-ignore-start -- Runner realtime cases intentionally retain complete handshake lifecycles.
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
test("acknowledges a runner restart only after its sessions drain", async () => {
  let finishDrain: (() => void) | undefined;
  const drained: string[] = [];
  const realtime = createRealtimeIntegration({
    auth: auth(null),
    hub: new RealtimeHub(),
    runnerVersion: "runner-version",
    runners: runners("qmr_runner-token", {
      connect: () => ({
        connection: { id: "runner-1", userId: USER.id },
        userId: USER.id,
      }),
    }),
    sessions: sessions({
      drainRunner: (runnerId, restartId) =>
        new Promise((resolve) => {
          drained.push(`${runnerId}:${restartId}`);
          finishDrain = () => {
            resolve();
          };
        }),
    }),
  });
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
  socket.sent.length = 0;

  void websocketMessage(
    realtime.websocket,
    socket,
    JSON.stringify({ restartId: "restart-1", type: "restart" }),
  );
  void websocketMessage(
    realtime.websocket,
    socket,
    JSON.stringify({ restartId: "restart-1", type: "restart" }),
  );
  expect(drained).toEqual(["runner-1:restart-1"]);
  expect(socket.sent).toEqual([]);

  finishDrain?.();
  await Promise.resolve();
  expect(socket.sent).toEqual([
    JSON.stringify({ restartId: "restart-1", type: "restart_ready" }),
  ]);
});

test("does not acknowledge a runner restart after its socket closes", async () => {
  let finishDrain: (() => void) | undefined;
  const realtime = integration(
    null,
    "qmr_runner-token",
    {
      connect: () => ({
        connection: { id: "runner-1", userId: USER.id },
        userId: USER.id,
      }),
    },
    {
      drainRunner: () =>
        new Promise((resolve) => {
          finishDrain = resolve;
        }),
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
  socket.sent.length = 0;
  void websocketMessage(
    realtime.websocket,
    socket,
    JSON.stringify({ restartId: "restart-2", type: "restart" }),
  );

  const close: unknown = Reflect.get(realtime.websocket, "close");
  if (typeof close !== "function") {
    throw new TypeError("The realtime close handler is unavailable");
  }
  Reflect.apply(close, undefined, [socket]);
  finishDrain?.();
  await Promise.resolve();
  expect(socket.sent).toEqual([]);
});

test("upgrades a token-authenticated runner realtime request", () => {
  // cpd-ignore-end
  expectUpgrade(integration(null, "qmr_runner-token"), RUNNER_REALTIME_PATH, {
    kind: "runner",
    restart: undefined,
    runner: undefined,
    token: "qmr_runner-token",
  });
});
