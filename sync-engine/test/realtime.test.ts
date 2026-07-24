import { expect, test } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { RUNNER_REALTIME_PATH } from "../../shared/routes.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { GLOBAL_WORKSPACE_ID } from "../../shared/workspace-model.ts";
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
  Pick<RunnerIntegration, "connect" | "listForUser" | "runnerToken" | "seen">
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
    remove: () => new Response(),
    runnerIsAvailable: () => false,
    runnerToken: () => token,
    seen: () => undefined,
    setDefault: () => new Response(),
    setScopes: () => Promise.resolve(new Response()),
    ...overrides,
  };
}

function sessions(
  overrides: Partial<
    Pick<SessionIntegration, "detailForUser" | "onChange" | "runnerConnected">
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
    stop: () => Promise.resolve(new Response()),
    ...overrides,
  };
}

function integration(
  user: AuthenticatedUser | null,
  token?: string,
  runnerOverrides?: RunnerIntegrationOverrides,
  sessionOverrides?: Partial<
    Pick<SessionIntegration, "detailForUser" | "onChange" | "runnerConnected">
  >,
  workspaceExists: (userId: string, workspaceId: string) => boolean = (
    userId,
    workspaceId,
  ) =>
    userId === USER.id &&
    (workspaceId === "workspace-1" || workspaceId === GLOBAL_WORKSPACE_ID),
) {
  return createRealtimeIntegration({
    auth: auth(user),
    hub: new RealtimeHub(),
    runnerVersion: "runner-version",
    runners: runners(token, runnerOverrides),
    sessions: sessions(sessionOverrides),
    workspaceExists,
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
  readonly messages: string[];
  close(): void;
  publish(): number;
  send(message: string): number;
  subscribe(): void;
  unsubscribe(): void;
}

function testSocket(data: QmushWebSocketData | undefined): TestSocket {
  if (data === undefined) {
    throw new Error("The test WebSocket did not upgrade");
  }
  const messages: string[] = [];
  return {
    close: () => undefined,
    data,
    messages,
    publish: () => 1,
    send: (message) => {
      messages.push(message);
      return 1;
    },
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  };
}

function websocketCall(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  methodName: "message" | "open",
  socket: TestSocket,
  message?: string,
): unknown {
  const method: unknown = Reflect.get(handler, methodName);
  if (typeof method !== "function") {
    throw new TypeError(`The realtime ${methodName} handler is unavailable`);
  }
  return Reflect.apply(
    method,
    undefined,
    message === undefined ? [socket] : [socket, message],
  );
}

function websocketMessage(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: TestSocket,
  message: string,
): unknown {
  return websocketCall(handler, "message", socket, message);
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

test("upgrades an authenticated browser realtime request with its workspace", () => {
  expectUpgrade(integration(USER), "/api/realtime?workspaceId=workspace-1", {
    kind: "user",
    user: USER,
    workspaceId: "workspace-1",
  });
});

test("rejects browser realtime requests without an owned workspace", () => {
  const server = new UpgradeServer();
  const realtime = integration(USER);

  expect(upgrade(realtime, "/api/realtime", server)?.status).toBe(401);
  expect(
    upgrade(realtime, "/api/realtime?workspaceId=unknown-workspace", server)
      ?.status,
  ).toBe(401);
  expect(server.data).toBeUndefined();
});

test("accepts Global as a virtual browser realtime workspace", () => {
  expectUpgrade(
    integration(USER),
    `/api/realtime?workspaceId=${GLOBAL_WORKSPACE_ID}`,
    {
      kind: "user",
      user: USER,
      workspaceId: GLOBAL_WORKSPACE_ID,
    },
  );
});

test("rejects a workspace owned by another user", () => {
  const server = new UpgradeServer();
  const realtime = integration(
    USER,
    undefined,
    undefined,
    undefined,
    (userId, workspaceId) =>
      userId === "user-2" && workspaceId === "other-workspace",
  );

  expect(
    upgrade(realtime, "/api/realtime?workspaceId=other-workspace", server)
      ?.status,
  ).toBe(401);
  expect(server.data).toBeUndefined();
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
test("publishes runner activity to every subscribed workspace scope", () => {
  const hub = new RealtimeHub();
  const listedScopes: (string | undefined)[] = [];
  const runnerIntegration = runners("qmr_runner-token", {
    connect: () => ({
      connection: { id: "runner-1", userId: USER.id },
      userId: USER.id,
    }),
    listForUser: (_userId, workspaceId) => {
      listedScopes.push(workspaceId);
      return [];
    },
  });
  const realtime = createRealtimeIntegration({
    auth: auth(USER),
    hub,
    runnerVersion: "runner-version",
    runners: runnerIntegration,
    sessions: sessions(),
    workspaceExists: (userId, workspaceId) =>
      userId === USER.id &&
      (workspaceId === "workspace-1" || workspaceId === "workspace-2"),
  });
  const workspaceSockets = ["workspace-1", "workspace-2"].map((workspaceId) => {
    const server = new UpgradeServer();
    expect(
      upgrade(realtime, `/api/realtime?workspaceId=${workspaceId}`, server),
    ).toBeUndefined();
    const socket = testSocket(server.data);
    websocketCall(realtime.websocket, "open", socket);
    socket.messages.length = 0;
    return socket;
  });
  listedScopes.length = 0;
  const runnerServer = new UpgradeServer();
  expect(upgrade(realtime, RUNNER_REALTIME_PATH, runnerServer)).toBeUndefined();
  websocketMessage(
    realtime.websocket,
    testSocket(runnerServer.data),
    JSON.stringify({
      architecture: "x64",
      machineId: "machine-1",
      name: "runner",
      platform: "linux",
      type: "connect",
    }),
  );

  expect(listedScopes).toEqual(["workspace-1", "workspace-2"]);
  for (const socket of workspaceSockets) {
    expect(socket.messages).toEqual(['{"runners":[],"type":"runners"}']);
  }
});

test("publishes session details only to the matching workspace", () => {
  const hub = new RealtimeHub();
  let onChange: ((userId: string, sessionId: string) => void) | undefined;
  const workspaceOneDetail = {
    activeDurationMs: 0,
    activeStartedAt: null,
    agentFile: null,
    autoCompact: true,
    costBasis: "none",
    costUsd: 0,
    createdAt: 1,
    credentialId: "credential-1",
    currentContextTokens: 0,
    id: "session-1",
    maxContextTokens: null,
    messages: [],
    model: "gpt-4.1-mini",
    provider: "openai",
    providerPricing: null,
    reasoningEffort: null,
    runnerId: "runner-1",
    status: "idle",
    title: "Workspace one session",
    tools: [],
    updatedAt: 1,
    workingDirectory: "/workspace-one",
    workspaceId: "workspace-1",
  } satisfies AgentSessionDetail;
  const realtime = createRealtimeIntegration({
    auth: auth(USER),
    hub,
    runnerVersion: "runner-version",
    runners: runners(undefined),
    sessions: sessions({
      detailForUser: (_userId, sessionId, workspaceId) =>
        sessionId === workspaceOneDetail.id &&
        workspaceId === workspaceOneDetail.workspaceId
          ? workspaceOneDetail
          : undefined,
      onChange: (listener) => {
        onChange = listener;
      },
    }),
    workspaceExists: (userId, workspaceId) =>
      userId === USER.id &&
      (workspaceId === "workspace-1" || workspaceId === "workspace-2"),
  });
  const sockets = new Map<string, TestSocket>();
  for (const workspaceId of ["workspace-1", "workspace-2"]) {
    const server = new UpgradeServer();
    expect(
      upgrade(realtime, `/api/realtime?workspaceId=${workspaceId}`, server),
    ).toBeUndefined();
    const socket = testSocket(server.data);
    websocketCall(realtime.websocket, "open", socket);
    socket.messages.length = 0;
    sockets.set(workspaceId, socket);
  }

  onChange?.(USER.id, workspaceOneDetail.id);

  expect(sockets.get("workspace-1")?.messages).toEqual([
    JSON.stringify({ session: workspaceOneDetail, type: "session" }),
    JSON.stringify({ sessions: [], type: "sessions" }),
  ]);
  expect(sockets.get("workspace-2")?.messages).toEqual([]);
});

test("upgrades a token-authenticated runner realtime request", () => {
  expectUpgrade(integration(null, "qmr_runner-token"), RUNNER_REALTIME_PATH, {
    kind: "runner",
    runner: undefined,
    token: "qmr_runner-token",
  });
});
