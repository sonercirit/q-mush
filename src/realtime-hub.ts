import type { RunnerToolCommand } from "./runner-command-broker.ts";

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
    return this.#connections[kind].get(`${kind}:${id}`);
  }

  #updateUser(userId: string, socket: RealtimeSocket, add: boolean): void {
    this.#update("user", `user:${userId}`, socket, add);
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

  setUser(userId: string, socket: RealtimeSocket, connected: boolean): void {
    if (connected) {
      this.#removeSocket(socket);
    }
    this.#updateUser(userId, socket, connected);
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

  publishUser(userId: string, payload: RealtimePayload): void {
    publish(this.#sockets("user", userId), payload);
  }
}
