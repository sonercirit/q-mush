import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import {
  createToolStreamHubState,
  type ToolStreamDeltaFrame,
} from "../shared/tool-stream.ts";

export interface RealtimeSocket {
  close(code?: number, reason?: string): void;
  send(message: string): number;
}

type RealtimePayload = Readonly<Record<string, unknown>>;

export interface RealtimeHub {
  currentRunner(runnerId: string): RealtimeSocket | undefined;
  runnerIsCurrent(runnerId: string, socket: RealtimeSocket): boolean;
  setRunner(
    runnerId: string,
    socket: RealtimeSocket,
    connected: boolean,
  ): RealtimeSocket | undefined;
  setUser(
    userId: string,
    socket: RealtimeSocket,
    connected: boolean,
    workspaceId?: string,
  ): void;
  userWorkspaces(userId: string): readonly string[];
  userIds(): readonly string[];
  publishRunnerCancellation(runnerId: string, commandId: string): void;
  publishRunnerCommand(runnerId: string, command: RunnerToolCommand): boolean;
  publishToolStream(
    userId: string,
    frame: ToolStreamDeltaFrame,
    workspaceId?: string,
  ): void;
  syncToolStreams(
    userId: string,
    sessionId: string,
    streamId: string,
    socket: RealtimeSocket,
  ): void;
  clearToolStreams(userId: string, sessionId: string): void;
  publishUser(
    userId: string,
    payload: RealtimePayload,
    workspaceId?: string,
  ): void;
  publishUserAllWorkspaces(userId: string, payload: RealtimePayload): void;
}

function publish(
  sockets: ReadonlySet<RealtimeSocket> | undefined,
  payload: RealtimePayload,
): boolean {
  if (sockets === undefined || sockets.size === 0) return false;
  const message = JSON.stringify(payload);
  let delivered = false;
  for (const socket of sockets) {
    try {
      delivered = socket.send(message) !== 0 || delivered;
    } catch {
      /* A closing socket must not prevent peer delivery. */
    }
  }
  return delivered;
}

export function createRealtimeHub(): RealtimeHub {
  const connections: Readonly<
    Record<"runner" | "user", Map<string, Set<RealtimeSocket>>>
  > = {
    runner: new Map(),
    user: new Map(),
  };
  const toolStreams = createToolStreamHubState();
  const userKey = (userId: string, workspaceId?: string): string =>
    `user:${userId}:${workspaceId ?? "*"}`;
  const parseUserKey = (
    key: string,
  ): { userId: string; workspaceId: string } | undefined => {
    const match = /^user:([^:]+):(.+)$/u.exec(key);
    return match === null
      ? undefined
      : { userId: match[1] ?? "", workspaceId: match[2] ?? "" };
  };
  const sockets = (
    kind: "runner" | "user",
    id: string,
  ): Set<RealtimeSocket> | undefined =>
    connections[kind].get(kind === "runner" ? `runner:${id}` : id);
  const removeSocket = (socket: RealtimeSocket): void => {
    for (const connectionMap of Object.values(connections)) {
      for (const [key, connected] of connectionMap) {
        if (connected.delete(socket) && connected.size === 0)
          connectionMap.delete(key);
      }
    }
  };
  const parsedUserKeys = (): readonly {
    userId: string;
    workspaceId: string;
  }[] =>
    [...connections.user.keys()].flatMap((key) => {
      const parsed = parseUserKey(key);
      return parsed === undefined ? [] : [parsed];
    });

  return {
    currentRunner: (runnerId) =>
      [...(sockets("runner", runnerId) ?? [])].at(-1),
    runnerIsCurrent: (runnerId, socket) =>
      sockets("runner", runnerId)?.has(socket) === true,
    setRunner: (runnerId, socket, connected) => {
      const key = `runner:${runnerId}`;
      const current = connections.runner.get(key);
      if (connected) {
        removeSocket(socket);
        connections.runner.set(key, new Set([socket]));
        const previous =
          current === undefined ? undefined : [...current].at(-1);
        return previous === socket ? undefined : previous;
      }
      if (current?.has(socket) === true) {
        connections.runner.delete(key);
        return socket;
      }
      return undefined;
    },
    setUser: (userId, socket, connected, workspaceId) => {
      if (connected) removeSocket(socket);
      const key = userKey(userId, workspaceId);
      const connectedSockets =
        connections.user.get(key) ?? new Set<RealtimeSocket>();
      if (connected) {
        connectedSockets.add(socket);
        connections.user.set(key, connectedSockets);
      } else {
        connectedSockets.delete(socket);
        if (connectedSockets.size === 0) connections.user.delete(key);
      }
    },
    userWorkspaces: (userId) =>
      parsedUserKeys().flatMap((parsed) =>
        parsed.userId === userId && parsed.workspaceId !== "*"
          ? [parsed.workspaceId]
          : [],
      ),
    userIds: () => [...new Set(parsedUserKeys().map(({ userId }) => userId))],
    publishRunnerCancellation: (runnerId, commandId) => {
      publish(sockets("runner", runnerId), { commandId, type: "cancel" });
    },
    publishRunnerCommand: (runnerId, command) =>
      publish(sockets("runner", runnerId), { command, type: "command" }),
    publishToolStream: (userId, frame, workspaceId) => {
      if (workspaceId !== undefined && toolStreams.apply(userId, frame))
        publish(sockets("user", userKey(userId, workspaceId)), { ...frame });
    },
    syncToolStreams: (userId, sessionId, streamId, socket) => {
      publish(new Set([socket]), {
        ...toolStreams.snapshot(userId, sessionId, streamId),
      });
    },
    clearToolStreams: (userId, sessionId) => {
      toolStreams.clearSession(userId, sessionId);
    },
    publishUser: (userId, payload, workspaceId) => {
      publish(sockets("user", userKey(userId, workspaceId)), payload);
    },
    publishUserAllWorkspaces: (userId, payload) => {
      const recipients = new Set<RealtimeSocket>();
      for (const [key, connected] of connections.user)
        if (parseUserKey(key)?.userId === userId)
          for (const socket of connected) recipients.add(socket);
      publish(recipients, payload);
    },
  };
}
