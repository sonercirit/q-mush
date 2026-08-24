import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createUuidV7 } from "../shared/ids.ts";
import { REALTIME_PATH, RUNNER_REALTIME_PATH } from "../shared/routes.ts";
import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import {
  readUserRealtimeCommand,
  RealtimeCommandError,
  USER_REALTIME_MAX_PAYLOAD_LENGTH,
  UserRealtimeProtocolError,
} from "../shared/user-realtime-protocol.ts";
import type { EngineHealth } from "./engine-health.ts";
import {
  createRealtimeCommandLedger,
  type RealtimeCommandLedger,
} from "./realtime-command-ledger.ts";
import type { RealtimeSocket } from "./realtime-hub.ts";
import { readRunnerClientMessage } from "./realtime-protocol.ts";
import { handleRunnerRegistrationAcknowledgement } from "./realtime-runner-acknowledgement.ts";
import { createRunnerRegistrationCoordinator } from "./realtime-runner-registration.ts";
import { handleRunnerRestartRequest } from "./realtime-runner-restart.ts";
import {
  closeServerError,
  safeSend,
  type RunnerRestartState,
  type RunnerSocketData,
} from "./realtime-runner-runtime.ts";
import type { RealtimeRegistrationDependencies } from "./realtime-runner-types.ts";
import {
  handleToolStreamSync,
  sendCommandError,
} from "./realtime-tool-sync.ts";
import { createWorkspaceSnapshotPublisher } from "./realtime-workspace-publisher.ts";
import type { RunnerConnection } from "./runner-store.ts";
import { executeSessionRealtimeCommand } from "./session-realtime-commands.ts";

interface UserSocketData {
  readonly kind: "user";
  readonly request: Request;
  readonly user: AuthenticatedUser;
  readonly workspaceId: string;
}

export type QmushWebSocketData = RunnerSocketData | UserSocketData;

export interface RealtimeIntegrationOptions extends Omit<
  RealtimeRegistrationDependencies,
  "sendCommand"
> {
  readonly health?: EngineHealth;
  readonly ledger?: RealtimeCommandLedger;
  readonly workspaceExists?: (userId: string, workspaceId: string) => boolean;
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

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return false;
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
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

const RUNNER_REALTIME_MAX_PAYLOAD_LENGTH = 128 * 1024 * 1024 + 1;
const DEFAULT_AUTH_REVALIDATION_INTERVAL_MS = 60_000;

function textMessage(message: string | Buffer): string {
  if (typeof message !== "string") {
    throw new Error("Binary WebSocket messages are not supported");
  }

  return message;
}

function isRunnerSocketData(value: unknown): value is RunnerSocketData {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "runner" &&
    "runner" in value &&
    "usable" in value
  );
}

function sendRunnerCommand(
  options: RealtimeIntegrationOptions,
  socket: RealtimeSocket,
  command: RunnerToolCommand,
): boolean {
  const runnerData: unknown = Reflect.get(socket, "data");
  if (!isRunnerSocketData(runnerData)) {
    return false;
  }
  return runnerData.runner !== undefined &&
    runnerData.usable &&
    options.hub.runnerIsCurrent(runnerData.runner.id, socket) &&
    options.hub.currentRunner(runnerData.runner.id) === socket
    ? safeSend(socket, JSON.stringify({ command, type: "command" }))
    : false;
}

function revalidateSocketUser(
  options: RealtimeIntegrationOptions,
  socket: RealtimeSocket,
  userData: UserSocketData,
): AuthenticatedUser | undefined {
  const user = options.auth.revalidateUser(userData.request, userData.user.id);
  if (user === null) {
    socket.close(1008, "Authentication expired");
    return undefined;
  }
  return user;
}

function stopRegisteredRunner(
  options: RealtimeIntegrationOptions,
  socket: RealtimeSocket,
  runner: RunnerConnection,
  publishRunners: (userId: string) => void,
): boolean {
  const removed = options.hub.setRunner(runner.id, socket, false);
  if (removed === undefined) {
    return false;
  }
  options.sessions.runnerDisconnected(runner.id);
  options.runners.disconnected(runner);
  publishRunners(runner.userId);
  return true;
}

export function createRealtimeIntegration(
  options: RealtimeIntegrationOptions,
): RealtimeIntegration {
  const instanceId = options.instanceId ?? createUuidV7();
  const ledger = options.ledger ?? createRealtimeCommandLedger();
  const authRevalidationIntervalMs =
    options.authRevalidationIntervalMs ?? DEFAULT_AUTH_REVALIDATION_INTERVAL_MS;
  const clearIntervalTimer = options.clearInterval ?? clearInterval;
  const setIntervalTimer = options.setInterval ?? setInterval;
  const userAuthTimers = new WeakMap<RealtimeSocket, number>();
  const runnerRestarts = new Map<string, RunnerRestartState>();
  options.health?.onChange((health) => {
    for (const userId of options.hub.userIds()) {
      options.hub.publishUser(userId, { health, type: "health" });
      for (const workspaceId of options.hub.userWorkspaces(userId)) {
        options.hub.publishUser(
          userId,
          { health, type: "health" },
          workspaceId,
        );
      }
    }
  });
  const publishSessions = createWorkspaceSnapshotPublisher(
    options.hub,
    "sessions",
    (userId, workspaceId) => options.sessions.listForUser(userId, workspaceId),
  );
  const publishRunners = createWorkspaceSnapshotPublisher(
    options.hub,
    "runners",
    (userId, workspaceId) => options.runners.listForUser(userId, workspaceId),
  );
  const publishRunnerActivity = (userId: string): void => {
    for (const workspaceId of options.hub.userWorkspaces(userId)) {
      publishRunners(userId, workspaceId);
    }
  };
  const sendUserSnapshots = (
    socket: RealtimeSocket,
    userId: string,
    workspaceId: string,
  ): boolean => {
    try {
      return (
        safeSend(
          socket,
          JSON.stringify({
            runners: options.runners.listForUser(userId, workspaceId),
            type: "runners",
          }),
        ) &&
        safeSend(
          socket,
          JSON.stringify({
            sessions: options.sessions.listForUser(userId, workspaceId),
            type: "sessions",
          }),
        )
      );
    } catch {
      return false;
    }
  };
  options.runners.onRemoved((userId, runnerId) => {
    const socket = options.hub.currentRunner(runnerId);
    if (socket !== undefined) {
      options.hub.setRunner(runnerId, socket, false);
      const data: unknown = Reflect.get(socket, "data");
      if (isRunnerSocketData(data)) {
        data.fenced = true;
        data.runner = undefined;
        data.usable = false;
      }
      try {
        socket.close(1000, "Runner removed");
      } catch {
        // Hub authority already fences the removed runner.
      }
    }
    publishRunnerActivity(userId);
  });
  options.sessions.onChange((userId, sessionId) => {
    for (const workspaceId of options.hub.userWorkspaces(userId)) {
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
      options.hub.publishUser(
        userId,
        {
          pending: options.sessions.pendingQuestionForUser(userId, sessionId),
          sessionId,
          type: "session_questions",
        },
        workspaceId,
      );
      publishSessions(userId, workspaceId);
      break;
    }
  });

  const registrationOptions = {
    ...options,
    sendCommand: (socket: RealtimeSocket, command: RunnerToolCommand) =>
      sendRunnerCommand(options, socket, command),
  };
  const registration = createRunnerRegistrationCoordinator({
    options: registrationOptions,
    publishRunners: publishRunnerActivity,
    runnerRestarts,
  });

  const websocket: Bun.WebSocketHandler<QmushWebSocketData> = {
    close(socket) {
      if (socket.data.kind === "runner") {
        registration.closed(socket, socket.data);
        if (socket.data.runner !== undefined && socket.data.usable) {
          const runner = socket.data.runner;
          stopRegisteredRunner(options, socket, runner, publishRunnerActivity);
        } else if (socket.data.runner !== undefined) {
          options.hub.setRunner(socket.data.runner.id, socket, false);
          socket.data.runner = undefined;
        }
      } else {
        const timer = userAuthTimers.get(socket);
        if (timer !== undefined) {
          clearIntervalTimer(timer);
          userAuthTimers.delete(socket);
        }
        options.hub.setUser(
          socket.data.user.id,
          socket,
          false,
          socket.data.workspaceId,
        );
      }
    },
    idleTimeout: 0,
    maxPayloadLength: USER_REALTIME_MAX_PAYLOAD_LENGTH,
    message(socket, rawMessage) {
      try {
        const message = textMessage(rawMessage);

        if (socket.data.kind === "runner") {
          if (
            Buffer.byteLength(message, "utf8") >=
            RUNNER_REALTIME_MAX_PAYLOAD_LENGTH
          ) {
            socket.close(1009, "Runner message too large");
            return;
          }
          if (socket.data.runner === undefined || !socket.data.usable) {
            if (socket.data.fenced) {
              socket.close(1008, "Runner connection was replaced");
              return;
            }
            if (socket.data.registration === undefined) {
              if (socket.data.runner !== undefined) {
                socket.close(1008, "Registration acknowledgement rejected");
                return;
              }
              registration.begin(socket, socket.data, message);
            } else {
              handleRunnerRegistrationAcknowledgement(
                registration,
                socket,
                socket.data,
                message,
              );
            }
            return;
          }

          const connectedRunner = socket.data.runner;
          if (
            !options.hub.runnerIsCurrent(connectedRunner.id, socket) ||
            options.hub.currentRunner(connectedRunner.id) !== socket
          ) {
            socket.close(1008, "Runner connection was replaced");
            return;
          }
          const event = readRunnerClientMessage(message);
          options.runners.seen(connectedRunner);
          publishRunnerActivity(connectedRunner.userId);

          if (event.type === "result") {
            options.sessions.completeRunnerCommand(
              connectedRunner.id,
              event.commandId,
              { output: event.output, state: event.state },
            );
            safeSend(
              socket,
              JSON.stringify({
                commandId: event.commandId,
                type: "result_received",
              }),
            );
          } else if (event.type === "cancellation_received") {
            options.sessions.acknowledgeRunnerCancellation(
              connectedRunner.id,
              event.commandId,
            );
          } else if (event.type === "output") {
            options.sessions.streamRunnerCommand(
              connectedRunner.id,
              event.commandId,
              event,
            );
          } else if (
            event.type === "restart" ||
            event.type === "restart_escalate"
          ) {
            handleRunnerRestartRequest(
              {
                options,
                restarts: runnerRestarts,
                runnerId: connectedRunner.id,
                socket,
              },
              event,
            );
          }
          return;
        }

        const userData = socket.data;
        const user = revalidateSocketUser(options, socket, userData);
        if (user === undefined) {
          return;
        }
        let command;
        try {
          command = readUserRealtimeCommand(message);
        } catch (error) {
          if (
            error instanceof UserRealtimeProtocolError &&
            handleToolStreamSync({
              commandError: error,
              hub: options.hub,
              message,
              sessions: options.sessions,
              socket,
              userId: user.id,
              workspaceId: userData.workspaceId,
            })
          ) {
            return;
          }
          if (
            error instanceof UserRealtimeProtocolError &&
            error.commandId !== undefined
          ) {
            sendCommandError(socket, error.commandId, "invalid_command");
            return;
          }
          throw error;
        }
        void ledger
          .execute(user.id, userData.workspaceId, command, () => {
            const current = options.auth.revalidateUser(
              userData.request,
              user.id,
            );
            if (current === null) {
              throw new RealtimeCommandError("authentication_expired");
            }
            return executeSessionRealtimeCommand(
              options.sessions.realtimeCommands,
              current,
              command,
              userData.workspaceId,
            );
          })
          .then((acknowledgement) => {
            if (!safeSend(socket, acknowledgement.serialized)) {
              closeServerError(socket, "Realtime acknowledgement failed");
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
        const user = revalidateSocketUser(options, socket, socket.data);
        if (user === undefined) {
          return;
        }
        if (!safeSend(socket, JSON.stringify({ instanceId, type: "ready" }))) {
          closeServerError(socket, "Realtime ready message failed");
          return;
        }
        if (
          options.health !== undefined &&
          !safeSend(
            socket,
            JSON.stringify({
              health: options.health.snapshot(),
              type: "health",
            }),
          )
        ) {
          closeServerError(socket, "Realtime health message failed");
          return;
        }
        if (!sendUserSnapshots(socket, user.id, socket.data.workspaceId)) {
          closeServerError(socket, "Realtime snapshot failed");
          return;
        }
        options.hub.setUser(user.id, socket, true, socket.data.workspaceId);
        const workspaceId = socket.data.workspaceId;
        const request = socket.data.request;
        const timer = setIntervalTimer(() => {
          const current = options.auth.revalidateUser(request, user.id);
          if (current === null) {
            clearIntervalTimer(timer);
            userAuthTimers.delete(socket);
            options.hub.setUser(user.id, socket, false, workspaceId);
            try {
              socket.close(1008, "Authentication expired");
            } catch {
              // The peer may already have closed the socket.
            }
          }
        }, authRevalidationIntervalMs);
        userAuthTimers.set(socket, timer);
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

      if (pathname === REALTIME_PATH && !sameOrigin(request)) {
        return new Response("Forbidden", { status: 403 });
      }

      const data: QmushWebSocketData | undefined =
        pathname === REALTIME_PATH
          ? (() => {
              const user = options.auth.authenticatedUser(request);
              const workspaceId = requestUrl.searchParams.get("workspaceId");
              return user === null ||
                workspaceId === null ||
                workspaceId.length === 0 ||
                options.workspaceExists?.(user.id, workspaceId) === false
                ? undefined
                : { kind: "user" as const, request, user, workspaceId };
            })()
          : (() => {
              const token = options.runners.runnerToken(request);
              return token === undefined
                ? undefined
                : {
                    committed: undefined,
                    fenced: false,
                    kind: "runner" as const,
                    registration: undefined,
                    runner: undefined,
                    token,
                    usable: false,
                  };
            })();

      if (data === undefined) {
        return new Response("Unauthorized", { status: 401 });
      }

      return server.upgrade(request, { data }) ? undefined : invalidUpgrade();
    },
    websocket,
  };
}
