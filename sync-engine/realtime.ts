import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { REALTIME_PATH, RUNNER_REALTIME_PATH } from "../shared/routes.ts";
import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import {
  readUserRealtimeCommand,
  USER_REALTIME_MAX_PAYLOAD_LENGTH,
  UserRealtimeProtocolError,
} from "../shared/user-realtime-protocol.ts";
import type { GoogleAuth } from "./auth.ts";
import {
  RealtimeCommandLedger,
  type RealtimeCommandAcknowledgement,
} from "./realtime-command-ledger.ts";
import type { RealtimeHub, RealtimeSocket } from "./realtime-hub.ts";
import {
  readRunnerClientMessage,
  readRunnerConnectMessage,
} from "./realtime-protocol.ts";
import type { RunnerConnection, RunnerMetadata } from "./runner-store.ts";
import { readRunnerMetadata, type RunnerIntegration } from "./runners.ts";
import { executeSessionRealtimeCommand } from "./session-realtime-commands.ts";
import type { SessionIntegration } from "./sessions.ts";

interface UserSocketData {
  readonly kind: "user";
  readonly sessionRequest: Request;
  readonly user: AuthenticatedUser;
}

interface RunnerSocketData {
  readonly kind: "runner";
  runner: RunnerConnection | undefined;
  readonly token: string;
}

export type QmushWebSocketData = RunnerSocketData | UserSocketData;

interface RealtimeIntegrationOptions {
  readonly auth: GoogleAuth;
  readonly commandLedger?: RealtimeCommandLedger;
  readonly hub: RealtimeHub;
  readonly instanceId?: string;
  readonly runnerVersion: string;
  readonly runners: RunnerIntegration;
  readonly sessions: SessionIntegration;
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
  const commandLedger = options.commandLedger ?? new RealtimeCommandLedger();
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const safelyClose = (
    socket: RealtimeSocket,
    code: number,
    reason: string,
  ): void => {
    try {
      socket.close(code, reason);
    } catch {
      // The peer may already have closed the socket.
    }
  };
  const publishSessions = (userId: string): void => {
    options.hub.publishUser(userId, {
      sessions: options.sessions.summariesForUser(userId),
      type: "sessions",
    });
  };
  const publishRunners = (userId: string): void => {
    options.hub.publishUser(userId, {
      runners: options.runners.listForUser(userId),
      type: "runners",
    });
  };
  const publishUserSnapshots = (userId: string): void => {
    publishRunners(userId);
    publishSessions(userId);
  };
  options.sessions.onChange((userId, sessionId) => {
    const session = options.sessions.readForUser(userId, sessionId);

    if (session !== undefined) {
      options.hub.publishUser(userId, { session, type: "session" });
    }
    publishSessions(userId);
  });

  const sendAcknowledgement = (
    socket: RealtimeSocket,
    acknowledgement: RealtimeCommandAcknowledgement,
  ): void => {
    try {
      if (socket.send(JSON.stringify(acknowledgement)) !== 0) {
        return;
      }
    } catch {
      // Closing the socket below forces any completed command to be replayed.
    }
    safelyClose(socket, 1011, "Acknowledgement delivery failed");
  };
  const handleUserCommand = async (
    socket: RealtimeSocket,
    data: UserSocketData,
    message: string,
  ): Promise<void> => {
    let command;
    try {
      command = readUserRealtimeCommand(message);
    } catch (error) {
      const commandId =
        error instanceof UserRealtimeProtocolError
          ? error.commandId
          : undefined;
      if (commandId !== undefined) {
        sendAcknowledgement(socket, {
          commandId,
          error: "invalid_command",
          type: "command_error",
        });
        return;
      }
      socket.close(1008, "Invalid command");
      return;
    }

    const revalidated = options.auth.revalidateUser(
      data.sessionRequest,
      data.user.id,
    );
    if (revalidated === null) {
      safelyClose(socket, 1008, "Authentication expired");
      return;
    }

    const acknowledgement = await commandLedger.execute(
      revalidated.id,
      command,
      () =>
        executeSessionRealtimeCommand(options.sessions, revalidated, command),
    );
    sendAcknowledgement(socket, acknowledgement);
  };

  const websocket: Bun.WebSocketHandler<QmushWebSocketData> = {
    close(socket) {
      if (socket.data.kind === "runner") {
        if (socket.data.runner !== undefined) {
          const runner = socket.data.runner;
          const disconnected = options.hub.setRunner(runner.id, socket, false);
          if (disconnected !== undefined) {
            options.runners.disconnected(runner);
            publishRunners(runner.userId);
          }
        }
      } else {
        options.hub.setUser(socket.data.user.id, socket, false);
      }
    },
    idleTimeout: 0,
    maxPayloadLength: USER_REALTIME_MAX_PAYLOAD_LENGTH,
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
            publishRunners(connected.userId);
            return;
          }

          const event = readRunnerClientMessage(message);
          const connectedRunner = socket.data.runner;
          options.runners.seen(connectedRunner);
          publishRunners(connectedRunner.userId);

          if (event.type === "result") {
            options.sessions.completeRunnerCommand(
              connectedRunner.id,
              event.commandId,
              event.output,
            );
          }
          return;
        }

        void handleUserCommand(socket, socket.data, message).catch(() => {
          try {
            socket.close(1011, "Command handling failed");
          } catch {
            // The peer may already have closed the socket.
          }
        });
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
        options.hub.setUser(socket.data.user.id, socket, true);
        if (socket.send(JSON.stringify({ instanceId, type: "ready" })) === 0) {
          safelyClose(socket, 1011, "Realtime handshake delivery failed");
          return;
        }
        publishUserSnapshots(socket.data.user.id);
      }
    },
    perMessageDeflate: true,
  };

  return {
    upgrade(request, server) {
      const pathname = new URL(request.url).pathname;

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
              return user === null
                ? undefined
                : { kind: "user" as const, sessionRequest: request, user };
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
