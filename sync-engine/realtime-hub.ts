import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import {
  ToolStreamHubState,
  type ToolStreamDeltaFrame,
} from "../shared/tool-stream.ts";

export interface RealtimeSocket {
  close(code?: number, reason?: string): void;
  send(message: string): number;
}

type RealtimePayload = Readonly<Record<string, unknown>>;

function updateSockets<Key>(
  sockets: Map<Key, Set<RealtimeSocket>>,
  key: Key,
  socket: RealtimeSocket,
  add: boolean,
): void {
  const existing = sockets.get(key) ?? new Set<RealtimeSocket>();

  if (add) {
    existing.add(socket);
    sockets.set(key, existing);
  } else {
    existing.delete(socket);
    if (existing.size === 0) {
      sockets.delete(key);
    }
  }
}

function publish(
  sockets: ReadonlySet<RealtimeSocket> | undefined,
  payload: RealtimePayload,
): boolean {
  if (sockets === undefined || sockets.size === 0) {
    return false;
  }

  const message = JSON.stringify(payload);
  let delivered = false;

  for (const socket of sockets) {
    try {
      delivered = socket.send(message) !== 0 || delivered;
    } catch {
      // A closing socket must not prevent delivery to its peers.
    }
  }

  return delivered;
}

export class RealtimeHub {
  readonly #connections: Readonly<
    Record<"runner" | "user", Map<string, Set<RealtimeSocket>>>
  > = {
    runner: new Map(),
    user: new Map(),
  };
  readonly #toolStreams = new ToolStreamHubState();

  #update(
    kind: "runner" | "user",
    id: string,
    socket: RealtimeSocket,
    add: boolean,
  ): void {
    updateSockets(this.#connections[kind], id, socket, add);
  }

  #removeSocket(socket: RealtimeSocket): void {
    for (const connections of Object.values(this.#connections)) {
      for (const [key, sockets] of connections) {
        if (sockets.delete(socket) && sockets.size === 0) {
          connections.delete(key);
        }
      }
    }
  }

  #sockets(kind: "runner" | "user", id: string) {
    const key = kind === "runner" ? `runner:${id}` : id;
    return this.#connections[kind].get(key);
  }

  #userKey(userId: string, workspaceId?: string): string {
    return `user:${userId}:${workspaceId ?? "*"}`;
  }

  #updateUser(
    userId: string,
    workspaceId: string | undefined,
    socket: RealtimeSocket,
    add: boolean,
  ): void {
    this.#update("user", this.#userKey(userId, workspaceId), socket, add);
  }

  currentRunner(runnerId: string): RealtimeSocket | undefined {
    return [...(this.#sockets("runner", runnerId) ?? [])].at(-1);
  }

  runnerIsCurrent(runnerId: string, socket: RealtimeSocket): boolean {
    return this.#sockets("runner", runnerId)?.has(socket) === true;
  }

  setRunner(
    runnerId: string,
    socket: RealtimeSocket,
    connected: boolean,
  ): RealtimeSocket | undefined {
    const key = `runner:${runnerId}`;
    const runners = this.#connections.runner;
    const current = runners.get(key);

    if (connected) {
      this.#removeSocket(socket);
      runners.set(key, new Set([socket]));
      const previous = current === undefined ? undefined : [...current].at(-1);
      return previous === socket ? undefined : previous;
    }

    if (current?.has(socket) === true) {
      runners.delete(key);
      return socket;
    }

    return undefined;
  }

  setUser(
    userId: string,
    socket: RealtimeSocket,
    connected: boolean,
    workspaceId?: string,
  ): void {
    if (connected) {
      this.#removeSocket(socket);
    }
    this.#updateUser(userId, workspaceId, socket, connected);
  }

  userWorkspaces(userId: string): readonly string[] {
    const prefix = `user:${userId}:`;
    return [...this.#connections.user.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((workspaceId) => workspaceId !== "*");
  }

  userIds(): readonly string[] {
    return [
      ...new Set(
        [...this.#connections.user.keys()]
          .map((key) => /^user:([^:]+):/u.exec(key)?.[1])
          .filter((userId) => userId !== undefined),
      ),
    ];
  }

  publishRunnerCancellation(runnerId: string, commandId: string): void {
    publish(this.#sockets("runner", runnerId), { commandId, type: "cancel" });
  }

  publishRunnerCommand(runnerId: string, command: RunnerToolCommand): boolean {
    return publish(this.#sockets("runner", runnerId), {
      command,
      type: "command",
    });
  }

  publishToolStream(
    userId: string,
    frame: ToolStreamDeltaFrame,
    workspaceId?: string,
  ): void {
    if (workspaceId === undefined || !this.#toolStreams.apply(userId, frame)) {
      return;
    }
    publish(this.#sockets("user", this.#userKey(userId, workspaceId)), {
      ...frame,
    });
  }

  syncToolStreams(
    userId: string,
    sessionId: string,
    streamId: string,
    socket: RealtimeSocket,
  ): void {
    publish(new Set([socket]), {
      ...this.#toolStreams.snapshot(userId, sessionId, streamId),
    });
  }

  clearToolStreams(userId: string, sessionId: string): void {
    this.#toolStreams.clearSession(userId, sessionId);
  }

  publishUser(
    userId: string,
    payload: RealtimePayload,
    workspaceId?: string,
  ): void {
    publish(this.#sockets("user", this.#userKey(userId, workspaceId)), payload);
  }

  publishUserAllWorkspaces(userId: string, payload: RealtimePayload): void {
    const sockets = new Set<RealtimeSocket>();
    for (const [key, connected] of this.#connections.user) {
      const [, connectedUserId] = key.split(":", 3);
      if (connectedUserId === userId) {
        for (const socket of connected) sockets.add(socket);
      }
    }
    publish(sockets, payload);
  }
}
