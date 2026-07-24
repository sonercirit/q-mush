import type { RunnerToolCommand } from "../shared/runner-command-broker.ts";
import type {
  ToolStreamDelta,
  ToolStreamEntry,
} from "../shared/tool-stream.ts";

export interface RealtimeSocket {
  close(code?: number, reason?: string): void;
  send(message: string): number;
}

type ToolStreamSnapshotEntry = ToolStreamEntry;

const MAXIMUM_TOOL_STREAM_SNAPSHOT_BYTES = 256 * 1_024;
const MAXIMUM_TOOL_STREAMS_PER_USER = 1_000;
const TERMINAL_TOOL_STATES = new Set([
  "canceled",
  "completed",
  "failed",
  "timed-out",
]);

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

  readonly #toolStreams = new Map<
    string,
    Map<string, ToolStreamSnapshotEntry>
  >();

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

  publishToolStream(
    userId: string,
    payload: RealtimePayload & ToolStreamDelta,
  ): void {
    if (
      payload.sequenceStart !== undefined ||
      (payload.channel === undefined) !== (payload.content === undefined) ||
      (payload.channel === undefined &&
        payload.state === undefined &&
        payload.previousCallId === undefined)
    ) {
      return;
    }
    const userStreams =
      this.#toolStreams.get(userId) ??
      new Map<string, ToolStreamSnapshotEntry>();
    const key = `${payload.sessionId}:${payload.streamId}:${String(payload.index)}`;
    const previousCallId = payload.previousCallId;
    const previous = userStreams.get(key);
    if (
      previous !== undefined &&
      previousCallId === undefined &&
      previous.callId !== payload.callId
    ) {
      return;
    }
    if (
      previous !== undefined &&
      previousCallId === undefined &&
      payload.sequence !== previous.sequence + 1
    ) {
      return;
    }
    if (
      previous === undefined &&
      previousCallId === undefined &&
      payload.sequence !== 0
    ) {
      return;
    }
    if (
      previousCallId !== undefined &&
      (previous?.callId !== previousCallId ||
        payload.sequence !== previous.sequence + 1)
    ) {
      return;
    }
    const base = previous;
    const content = payload.content ?? "";
    const channel = payload.channel;
    const state = payload.state;
    const next: ToolStreamSnapshotEntry = {
      arguments:
        channel === "arguments"
          ? `${base?.arguments ?? ""}${content}`
          : (base?.arguments ?? ""),
      callId: payload.callId,
      index: payload.index,
      name:
        channel === "name"
          ? `${base?.name ?? ""}${content}`
          : (base?.name ?? ""),
      sequence: payload.sequence,
      sessionId: payload.sessionId,
      state: state ?? base?.state ?? "preparing",
      stderr:
        channel === "stderr"
          ? `${base?.stderr ?? ""}${content}`
          : (base?.stderr ?? ""),
      stdout:
        channel === "stdout"
          ? `${base?.stdout ?? ""}${content}`
          : (base?.stdout ?? ""),
      streamId: payload.streamId,
    };
    const serialized = JSON.stringify(next);
    userStreams.set(
      key,
      serialized.length <= MAXIMUM_TOOL_STREAM_SNAPSHOT_BYTES
        ? next
        : { ...next, stderr: "", stdout: "" },
    );
    if (userStreams.size > MAXIMUM_TOOL_STREAMS_PER_USER) {
      const oldest = userStreams.keys().next().value;
      if (oldest !== undefined) {
        userStreams.delete(oldest);
      }
    }
    this.#toolStreams.set(userId, userStreams);
    this.publishUser(userId, payload);
    if (state !== undefined && TERMINAL_TOOL_STATES.has(state)) {
      queueMicrotask(() => {
        const current = userStreams.get(key);
        if (
          current?.callId !== payload.callId ||
          current.sequence !== payload.sequence
        ) {
          return;
        }
        userStreams.delete(key);
        if (userStreams.size === 0) {
          this.#toolStreams.delete(userId);
        }
      });
    }
  }

  syncToolStreams(
    userId: string,
    sessionId: string,
    streamId: string,
    socket: RealtimeSocket,
  ): void {
    const streams = [...(this.#toolStreams.get(userId)?.values() ?? [])].filter(
      (entry) => entry.sessionId === sessionId && entry.streamId === streamId,
    );
    publish(new Set([socket]), {
      sessionId,
      streamId,
      streams,
      type: "tool_stream_snapshot",
    });
  }

  clearToolStreams(userId: string, sessionId: string): void {
    const streams = this.#toolStreams.get(userId);
    if (streams === undefined) {
      return;
    }
    for (const [key, stream] of streams) {
      if (stream.sessionId === sessionId) {
        streams.delete(key);
      }
    }
    if (streams.size === 0) {
      this.#toolStreams.delete(userId);
    }
  }

  publishUser(userId: string, payload: RealtimePayload): void {
    publish(this.#sockets("user", userId), payload);
  }
}
