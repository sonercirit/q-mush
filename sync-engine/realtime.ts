import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { REALTIME_PATH, RUNNER_REALTIME_PATH } from "../shared/routes.ts";
import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import type { GoogleAuth } from "./auth.ts";
import type { RealtimeHub, RealtimeSocket } from "./realtime-hub.ts";
import {
  readQmushClientMessage,
  readRunnerClientMessage,
  readRunnerConnectMessage,
} from "./realtime-protocol.ts";
import type { RunnerConnection, RunnerMetadata } from "./runner-store.ts";
import { readRunnerMetadata, type RunnerIntegration } from "./runners.ts";
import type { SessionIntegration } from "./sessions.ts";

interface UserSocketData {
  readonly kind: "user";
  readonly user: AuthenticatedUser;
  readonly workspaceId: string;
}

interface RunnerSocketData {
  readonly kind: "runner";
  runner: RunnerConnection | undefined;
  readonly token: string;
}

export type QmushWebSocketData = RunnerSocketData | UserSocketData;

interface RealtimeIntegrationOptions {
  readonly auth: GoogleAuth;
  readonly hub: RealtimeHub;
  readonly runnerVersion: string;
  readonly runners: RunnerIntegration;
  readonly sessions: SessionIntegration;
  readonly workspaceExists: (userId: string, workspaceId: string) => boolean;
}

interface RealtimeUpgradeServer {
  upgrade(
    request: Request,
    options: { readonly data: QmushWebSocketData },
  ): boolean;
}

export interface RealtimeIntegration {
  readonly websocket: Bun.WebSocketHandler<QmushWebSocketData>;
  upgrade(
    request: Request,
    server: RealtimeUpgradeServer,
  ): Response | undefined;
}

export function isRealtimePath(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === REALTIME_PATH || pathname === RUNNER_REALTIME_PATH;
}

function upgradeRequired(): Response {
  return new Response("WebSocket upgrade required", {
    headers: { upgrade: "websocket" },
    status: 426,
  });
}

function invalidUpgrade(): Response {
  return new Response("WebSocket upgrade failed", { status: 400 });
}

function textMessage(message: string | Buffer): string {
  if (typeof message !== "string") {
    throw new Error("Binary WebSocket messages are not supported");
  }

  return message;
}

function sendCommand(
  socket: RealtimeSocket,
  command: RunnerToolCommand,
): boolean {
  try {
    return socket.send(JSON.stringify({ command, type: "command" })) !== 0;
  } catch {
    return false;
  }
}

export function createRealtimeIntegration(
  options: RealtimeIntegrationOptions,
): RealtimeIntegration {
  const publishSessions = (userId: string, workspaceId: string): void => {
    options.hub.publishUser(
      userId,
      {
        sessions: options.sessions.listForUser(userId, workspaceId),
        type: "sessions",
      },
      workspaceId,
    );
  };
  const publishRunners = (userId: string, workspaceId: string): void => {
    options.hub.publishUser(
      userId,
      {
        runners: options.runners.listForUser(userId, workspaceId),
        type: "runners",
      },
      workspaceId,
    );
  };
  const publishRunnerActivity = (userId: string): void => {
    for (const workspaceId of options.hub.userWorkspaces(userId)) {
      publishRunners(userId, workspaceId);
    }
  };
  const publishUserSnapshots = (userId: string, workspaceId: string): void => {
    publishRunners(userId, workspaceId);
    publishSessions(userId, workspaceId);
  };
  options.sessions.onChange((userId, sessionId) => {
    const sessionWorkspaceIds = options.hub.userWorkspaces(userId);
    for (const workspaceId of sessionWorkspaceIds) {
      const session = options.sessions.detailForUser(
        userId,
        sessionId,
        workspaceId,
      );
      if (session === undefined) {
        continue;
      }
      options.hub.publishUser(
        userId,
        { session, type: "session" },
        workspaceId,
      );
      publishSessions(userId, workspaceId);
      break;
    }
  });

  const websocket: Bun.WebSocketHandler<QmushWebSocketData> = {
    close(socket) {
      if (socket.data.kind === "runner") {
        if (socket.data.runner !== undefined) {
          const runner = socket.data.runner;
          const disconnected = options.hub.setRunner(runner.id, socket, false);
          if (disconnected !== undefined) {
            options.runners.disconnected(runner);
            publishRunnerActivity(runner.userId);
          }
        }
      } else {
        options.hub.setUser(
          socket.data.user.id,
          socket,
          false,
          socket.data.workspaceId,
        );
      }
    },
    idleTimeout: 0,
    message(socket, rawMessage) {
      try {
        const message = textMessage(rawMessage);

        if (socket.data.kind === "runner") {
          if (socket.data.runner === undefined) {
            const connect = readRunnerConnectMessage(message);
            const metadata: RunnerMetadata | undefined = readRunnerMetadata({
              architecture: connect.architecture,
              machineId: connect.machineId,
              name: connect.name,
              platform: connect.platform,
            });
            const connected =
              metadata === undefined
                ? undefined
                : options.runners.connect(socket.data.token, metadata);

            if (connected === undefined) {
              socket.close(1008, "Registration rejected");
              return;
            }

            const runner = connected.connection;
            socket.data.runner = runner;
            options.runners.seen(runner);
            const replaced = options.hub.setRunner(runner.id, socket, true);
            replaced?.close(1000, "Replaced by a newer runner connection");
            socket.send(
              JSON.stringify({
                runnerId: runner.id,
                type: "ready",
                version: options.runnerVersion,
              }),
            );
            options.sessions.deliverRunnerCommands(runner.id, (command) =>
              sendCommand(socket, command),
            );
            options.sessions.runnerConnected();
            publishRunnerActivity(connected.userId);
            return;
          }

          const event = readRunnerClientMessage(message);
          const connectedRunner = socket.data.runner;
          options.runners.seen(connectedRunner);
          publishRunnerActivity(connectedRunner.userId);

          if (event.type === "result") {
            options.sessions.completeRunnerCommand(
              connectedRunner.id,
              event.commandId,
              event.output,
            );
          }
          return;
        }

        readQmushClientMessage(message);
        publishUserSnapshots(socket.data.user.id, socket.data.workspaceId);
      } catch {
        try {
          socket.close(1008, "Invalid message");
        } catch {
          // The peer may already have closed the socket.
        }
      }
    },
    open(socket) {
      if (socket.data.kind === "runner") {
        // Runner registration starts with a metadata message after the upgrade.
      } else {
        options.hub.setUser(
          socket.data.user.id,
          socket,
          true,
          socket.data.workspaceId,
        );
        publishUserSnapshots(socket.data.user.id, socket.data.workspaceId);
      }
    },
    perMessageDeflate: true,
  };

  return {
    upgrade(request, server) {
      const requestUrl = new URL(request.url);
      const pathname = requestUrl.pathname;

      if (pathname !== REALTIME_PATH && pathname !== RUNNER_REALTIME_PATH) {
        return undefined;
      }

      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return upgradeRequired();
      }

      const data: QmushWebSocketData | undefined =
        pathname === REALTIME_PATH
          ? (() => {
              const user = options.auth.authenticatedUser(request);
              const workspaceId = requestUrl.searchParams.get("workspaceId");
              return user === null ||
                workspaceId === null ||
                !options.workspaceExists(user.id, workspaceId)
                ? undefined
                : {
                    kind: "user" as const,
                    user,
                    workspaceId,
                  };
            })()
          : (() => {
              const token = options.runners.runnerToken(request);
              return token === undefined
                ? undefined
                : { kind: "runner" as const, runner: undefined, token };
            })();

      if (data === undefined) {
        return new Response("Unauthorized", { status: 401 });
      }

      return server.upgrade(request, { data }) ? undefined : invalidUpgrade();
    },
    websocket,
  };
}
