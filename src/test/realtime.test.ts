import { expect, test } from "bun:test";
import type { AuthenticatedUser } from "../auth-model.ts";
import type { GoogleAuth } from "../auth.ts";
import { RealtimeHub } from "../realtime-hub.ts";
import {
  createRealtimeIntegration,
  type QmushWebSocketData,
} from "../realtime.ts";
import { RUNNER_REALTIME_PATH } from "../routes.ts";
import type { RunnerIntegration } from "../runners.ts";
import type { SessionIntegration } from "../sessions.ts";

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

function sessions(): SessionIntegration {
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
    stop: () => Promise.resolve(new Response()),
  };
}

function integration(
  user: AuthenticatedUser | null,
  token?: string,
  runnerOverrides?: RunnerIntegrationOverrides,
) {
  return createRealtimeIntegration({
    auth: auth(user),
    hub: new RealtimeHub(),
    runnerVersion: "runner-version",
    runners: runners(token, runnerOverrides),
    sessions: sessions(),
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

test("upgrades a token-authenticated runner realtime request", () => {
  expectUpgrade(integration(null, "qmr_runner-token"), RUNNER_REALTIME_PATH, {
    kind: "runner",
    runner: undefined,
    token: "qmr_runner-token",
  });
});
