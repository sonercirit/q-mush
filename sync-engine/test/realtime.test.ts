import { expect, test } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { RUNNER_REALTIME_PATH } from "../../shared/routes.ts";
import type { GoogleAuth } from "../../sync-engine/auth.ts";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import {
  readQmushClientMessage,
  readRunnerClientMessage,
} from "../../sync-engine/realtime-protocol.ts";
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
    Pick<
      SessionIntegration,
      "runnerConnected" | "runnerDisconnected" | "streamRunnerCommand"
    >
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
    item: () => new Response(),
    listForUser: () => [],
    message: () => Promise.resolve(new Response()),
    models: () => Promise.resolve(new Response()),
    onChange: () => undefined,
    runnerConnected: () => undefined,
    runnerDisconnected: () => undefined,
    streamRunnerCommand: () => false,
    stop: () => Promise.resolve(new Response()),
    ...overrides,
  };
}

function integration(
  user: AuthenticatedUser | null,
  token?: string,
  runnerOverrides?: RunnerIntegrationOverrides,
  sessionOverrides?: Partial<
    Pick<
      SessionIntegration,
      "runnerConnected" | "runnerDisconnected" | "streamRunnerCommand"
    >
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

function websocketClose(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: TestSocket,
): unknown {
  const method: unknown = Reflect.get(handler, "close");
  if (typeof method !== "function") {
    throw new TypeError("The realtime close handler is unavailable");
  }
  return Reflect.apply(method, undefined, [socket, 1006, "lost"]);
}

function runnerConnection(): RunnerIntegrationOverrides {
  return {
    connect: () => ({
      connection: {
        id: "runner-1",
        tokenHash: "hash",
        userId: USER.id,
      },
      userId: USER.id,
    }),
  };
}

function runnerConnectMessage(): string {
  return JSON.stringify({
    architecture: "x64",
    machineId: "machine-1",
    name: "runner",
    platform: "linux",
    type: "connect",
  });
}

function connectRunnerSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
): TestSocket {
  const server = new UpgradeServer();
  expect(upgrade(realtime, RUNNER_REALTIME_PATH, server)).toBeUndefined();
  const socket = testSocket(server.data);
  void websocketMessage(realtime.websocket, socket, runnerConnectMessage());
  return socket;
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

function runnerOutputDelta() {
  return {
    channel: "stderr" as const,
    commandId: "command-1",
    content: "warning",
    sequence: 0,
    type: "output" as const,
  };
}

function runnerOutputMessage(): string {
  return JSON.stringify(runnerOutputDelta());
}

const RUNNER_TOKEN = "qmr_runner-token";

function runnerRealtime(sessionOverrides: Parameters<typeof integration>[3]) {
  return integration(null, RUNNER_TOKEN, runnerConnection(), sessionOverrides);
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

test("bounds browser synchronization IDs and runner output bytes", () => {
  const oversized = "é".repeat(16_385);
  expect(() =>
    readQmushClientMessage(
      JSON.stringify({
        sessionId: "session-1",
        streamId: "x".repeat(1_025),
        type: "sync_tools",
      }),
    ),
  ).toThrow("invalid");
  expect(() =>
    readRunnerClientMessage(
      JSON.stringify({
        channel: "stdout",
        commandId: "command-1",
        content: oversized,
        sequence: 0,
        type: "output",
      }),
    ),
  ).toThrow("invalid");
});

test("routes explicit runner output and disconnect settlement", () => {
  const events: unknown[] = [];
  const realtime = runnerRealtime({
    runnerConnected: () => undefined,
    runnerDisconnected: (runnerId) => {
      events.push({ disconnected: runnerId });
    },
    streamRunnerCommand: (runnerId, commandId, delta) => {
      events.push({ commandId, delta, runnerId });
      return true;
    },
  });
  const socket = connectRunnerSocket(realtime);
  void websocketMessage(realtime.websocket, socket, runnerOutputMessage());

  void websocketClose(realtime.websocket, socket);
  expect(events).toEqual([
    {
      commandId: "command-1",
      delta: runnerOutputDelta(),
      runnerId: "runner-1",
    },
    { disconnected: "runner-1" },
  ]);
});

test("recovers and wakes completed child callbacks when a runner connects", () => {
  const connectedUsers: string[] = [];
  const realtime = runnerRealtime({
    runnerConnected: () => {
      connectedUsers.push(USER.id);
    },
  });
  connectRunnerSocket(realtime);
  expect(connectedUsers).toEqual([USER.id]);
});

test("upgrades a token-authenticated runner realtime request", () => {
  expectUpgrade(integration(null, RUNNER_TOKEN), RUNNER_REALTIME_PATH, {
    kind: "runner",
    runner: undefined,
    token: RUNNER_TOKEN,
  });
});
