import { expect, test, vi } from "vitest";
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
import { TEST_REALTIME_SESSION_DETAIL } from "./realtime-session-fixture.ts";

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

type SessionOverrides = Partial<SessionIntegration>;

function sessions(overrides: SessionOverrides = {}): SessionIntegration {
  return {
    compactForUser: () => Promise.reject(new Error("unused")),
    completeRunnerCommand: () => false,
    continueForUser: () => Promise.reject(new Error("unused")),
    createForUser: () => Promise.reject(new Error("unused")),
    deliverRunnerCommands: () => undefined,
    readForUser: () => undefined,
    directories: () => Promise.resolve(new Response()),
    drain: () => Promise.resolve(),
    summariesForUser: () => [],
    messageForUser: () => Promise.reject(new Error("unused")),
    modelsForUser: () => Promise.resolve({ defaultModel: null, models: [] }),
    onChange: () => undefined,
    runnerConnected: () => undefined,
    setAutoCompactionForUser: () => {
      throw new Error("unused");
    },
    stopForUser: () => {
      throw new Error("unused");
    },
    ...overrides,
  };
}

function integration(
  user: AuthenticatedUser | null,
  token?: string,
  runnerOverrides?: RunnerIntegrationOverrides,
  sessionOverrides?: SessionOverrides,
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
  close(code?: number, reason?: string): void;
  publish(): number;
  send(message: string): number;
  subscribe(): void;
  unsubscribe(): void;
}

type SocketOverrides = Partial<Pick<TestSocket, "close" | "send">>;

function testSocket(
  data: QmushWebSocketData | undefined,
  overrides: SocketOverrides = {},
): TestSocket {
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
    ...overrides,
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

function userSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  overrides: SocketOverrides = {},
): TestSocket {
  const server = new UpgradeServer();
  expect(upgrade(realtime, "/api/realtime", server)).toBeUndefined();
  return testSocket(server.data, overrides);
}

function commandMessage(
  commandId: string,
  idempotencyKey: string,
  operation = "sessions.subscribe",
  payload: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    commandId,
    idempotencyKey,
    operation,
    payload,
    type: "command",
  });
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function sendUserMessage(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  socket: TestSocket,
  message: string,
): Promise<void> {
  websocketMessage(realtime.websocket, socket, message);
  await nextTask();
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
  const realtime = integration(USER);
  expect(realtime.websocket.maxPayloadLength).toBe(128 * 1024 * 1024 + 1);
  expectUpgrade(realtime, "/api/realtime", {
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

test("acknowledges malformed correlated commands and rejects uncorrelated messages", async () => {
  const realtime = integration(USER);
  const sent: string[] = [];
  const closes: [number | undefined, string | undefined][] = [];
  const socket = userSocket(realtime, {
    close: (code, reason) => {
      closes.push([code, reason]);
    },
    send: (message) => {
      sent.push(message);
      return 1;
    },
  });

  await sendUserMessage(
    realtime,
    socket,
    commandMessage("command-invalid", "mutation-invalid", "bad operation"),
  );
  await sendUserMessage(realtime, socket, JSON.stringify({ type: "refresh" }));

  expect(JSON.parse(sent[0] ?? "null")).toEqual({
    commandId: "command-invalid",
    error: "invalid_command",
    type: "command_error",
  });
  expect(closes).toContainEqual([1008, "Invalid command"]);
});

test("replays a completed command after its socket disconnects", async () => {
  let complete: ((value: AgentSessionDetail) => void) | undefined;
  const createForUser = vi.fn(
    () =>
      new Promise<AgentSessionDetail>((resolve) => {
        complete = resolve;
      }),
  );
  const realtime = integration(USER, undefined, undefined, { createForUser });
  const firstSocket = userSocket(realtime, {
    send: () => {
      throw new Error("The socket disconnected");
    },
  });
  const message = commandMessage(
    "command-create",
    "mutation-create",
    "sessions.create",
    {
      credentialId: "credential-1",
      model: "gpt-test",
      prompt: "Do the work",
      provider: "openai",
      runnerId: "runner-1",
      tools: [],
      workingDirectory: "/work",
    },
  );
  websocketMessage(realtime.websocket, firstSocket, message);
  await vi.waitFor(() => {
    expect(createForUser).toHaveBeenCalledOnce();
  });
  const replayDetail: AgentSessionDetail = {
    ...TEST_REALTIME_SESSION_DETAIL,
    credentialId: "credential-1",
    id: "session-1",
    model: "gpt-test",
    provider: "openai",
    runnerId: "runner-1",
    status: "queued",
    title: "Do the work",
    tools: [],
    workingDirectory: "/work",
  };
  complete?.(replayDetail);
  await nextTask();

  const sent: string[] = [];
  const replaySocket = userSocket(realtime, {
    send: (acknowledgement) => {
      sent.push(acknowledgement);
      return 1;
    },
  });
  await sendUserMessage(realtime, replaySocket, message);

  expect(createForUser).toHaveBeenCalledOnce();
  expect(JSON.parse(sent.at(-1) ?? "null")).toMatchObject({
    commandId: "command-create",
    result: { id: "session-1", status: "queued" },
    type: "command_success",
  });
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
test("upgrades a token-authenticated runner realtime request", () => {
  expectUpgrade(integration(null, "qmr_runner-token"), RUNNER_REALTIME_PATH, {
    kind: "runner",
    runner: undefined,
    token: "qmr_runner-token",
  });
});
