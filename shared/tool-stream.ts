import { isValidBoundedString } from "./string-validation.ts";
import { utf8ByteLength } from "./utf8.ts";
import { isRecord } from "./validation.ts";

export const MAXIMUM_TOOL_STREAM_DELTA_BYTES = 32 * 1_024;
export const MAXIMUM_TOOL_STREAM_FIELD_BYTES = 256 * 1_024;
export const MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH = 1_024;
export const MAXIMUM_TOOL_STREAMS_PER_SESSION = 100;
export const MAXIMUM_TOOL_STREAMS_PER_USER = 1_000;
export const TOOL_STREAM_TRUNCATED_MARKER = "\n[stream truncated]";

export type ToolStreamTerminalState =
  "completed" | "failed" | "canceled" | "timed-out";

const TOOL_STREAM_TERMINAL_STATES: readonly ToolStreamTerminalState[] = [
  "canceled",
  "completed",
  "failed",
  "timed-out",
];

function isToolStreamTerminalState(
  value: unknown,
): value is ToolStreamTerminalState {
  return TOOL_STREAM_TERMINAL_STATES.some((state) => state === value);
}

export function aggregateToolStreamState(
  states: ReadonlySet<ToolStreamTerminalState>,
): ToolStreamTerminalState {
  for (const candidate of ["timed-out", "canceled", "failed"] as const) {
    if (states.has(candidate)) {
      return candidate;
    }
  }
  return "completed";
}

export type ToolStreamState = "preparing" | "running" | ToolStreamTerminalState;
export type ToolStreamChannel = "arguments" | "name" | "stderr" | "stdout";
type RunnerOutputChannel = Extract<ToolStreamChannel, "stderr" | "stdout">;

export interface ProviderToolCallDelta {
  readonly arguments: string;
  readonly id: string;
  readonly index: number;
  readonly name: string;
}

export interface RunnerCommandOutputDelta {
  readonly channel: RunnerOutputChannel;
  readonly content: string;
  readonly sequence: number;
}

export interface RunnerCommandResult {
  readonly output: string;
  readonly state: ToolStreamTerminalState;
}

export interface ToolStreamDelta {
  readonly callId: string;
  readonly channel?: ToolStreamChannel;
  readonly content?: string;
  readonly index: number;
  readonly previousCallId?: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly state?: ToolStreamState;
  readonly streamId: string;
}

export interface ToolStreamDeltaFrame extends ToolStreamDelta {
  readonly type: "tool_stream";
}

export interface ToolStreamEntry {
  readonly arguments: string;
  readonly callId: string;
  readonly index: number;
  readonly name: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly state: ToolStreamState;
  readonly stderr: string;
  readonly stdout: string;
  readonly streamId: string;
}

export interface ToolStreamSnapshotFrame {
  readonly sessionId: string;
  readonly streamId: string;
  readonly streams: readonly ToolStreamEntry[];
  readonly type: "tool_stream_snapshot";
}

type ToolStreamDeltaRejection =
  | "bounds"
  | "gap"
  | "identity"
  | "initial"
  | "invalid"
  | "late"
  | "terminal"
  | "transition";

export type ApplyToolStreamDeltaResult =
  | {
      readonly accepted: true;
      readonly entry: ToolStreamEntry;
      readonly previousCallId?: string;
      readonly terminal: boolean;
    }
  | {
      readonly accepted: false;
      readonly reason: ToolStreamDeltaRejection;
    };

function isBoundedIdentifier(value: unknown): value is string {
  return (
    isValidBoundedString(value, MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH, {
      allowNullCharacter: true,
    }) && utf8ByteLength(value) <= MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH
  );
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isToolStreamState(value: unknown): value is ToolStreamState {
  return (
    value === "preparing" ||
    value === "running" ||
    isToolStreamTerminalState(value)
  );
}

function isToolStreamChannel(value: unknown): value is ToolStreamChannel {
  return (
    value === "arguments" ||
    value === "name" ||
    value === "stderr" ||
    value === "stdout"
  );
}

/** @public Validates provider tool-call stream deltas. */
export function validToolCallField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    utf8ByteLength(value) <= MAXIMUM_TOOL_STREAM_FIELD_BYTES
  );
}

/** @public Validates provider tool-call stream deltas. */
export function isProviderToolCallDelta(
  value: unknown,
): value is ProviderToolCallDelta {
  if (!isRecord(value)) {
    return false;
  }
  return (
    validToolCallField(value["arguments"]) &&
    typeof value["id"] === "string" &&
    utf8ByteLength(value["id"]) <= MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH &&
    isSequence(value["index"]) &&
    validToolCallField(value["name"])
  );
}

export function isRunnerCommandOutputDelta(
  value: unknown,
): value is RunnerCommandOutputDelta {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value["channel"] === "stderr" || value["channel"] === "stdout") &&
    typeof value["content"] === "string" &&
    utf8ByteLength(value["content"]) <= MAXIMUM_TOOL_STREAM_DELTA_BYTES &&
    isSequence(value["sequence"])
  );
}

export function isRunnerCommandResult(
  value: unknown,
): value is RunnerCommandResult {
  return (
    isRecord(value) &&
    typeof value["output"] === "string" &&
    isToolStreamTerminalState(value["state"])
  );
}

function isToolStreamDelta(value: unknown): value is ToolStreamDelta {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isBoundedIdentifier(value["callId"]) ||
    !isSequence(value["index"]) ||
    !isSequence(value["sequence"]) ||
    !isBoundedIdentifier(value["sessionId"]) ||
    !isBoundedIdentifier(value["streamId"])
  ) {
    return false;
  }

  const hasChannel = value["channel"] !== undefined;
  const hasContent = value["content"] !== undefined;
  if (hasChannel !== hasContent) {
    return false;
  }
  if (
    hasChannel &&
    (!isToolStreamChannel(value["channel"]) ||
      typeof value["content"] !== "string" ||
      utf8ByteLength(value["content"]) > MAXIMUM_TOOL_STREAM_DELTA_BYTES)
  ) {
    return false;
  }
  if (
    value["previousCallId"] !== undefined &&
    !isBoundedIdentifier(value["previousCallId"])
  ) {
    return false;
  }
  if (value["state"] !== undefined && !isToolStreamState(value["state"])) {
    return false;
  }

  const changes =
    Number(hasChannel) +
    Number(value["previousCallId"] !== undefined) +
    Number(value["state"] !== undefined);
  return changes === 1;
}

export function isToolStreamDeltaFrame(
  value: unknown,
): value is ToolStreamDeltaFrame {
  return (
    isRecord(value) &&
    value["type"] === "tool_stream" &&
    isToolStreamDelta(value)
  );
}

function isToolStreamEntry(value: unknown): value is ToolStreamEntry {
  return (
    isRecord(value) &&
    validToolCallField(value["arguments"]) &&
    isBoundedIdentifier(value["callId"]) &&
    isSequence(value["index"]) &&
    validToolCallField(value["name"]) &&
    isSequence(value["sequence"]) &&
    isBoundedIdentifier(value["sessionId"]) &&
    isToolStreamState(value["state"]) &&
    typeof value["stderr"] === "string" &&
    utf8ByteLength(value["stderr"]) <= MAXIMUM_TOOL_STREAM_FIELD_BYTES &&
    typeof value["stdout"] === "string" &&
    utf8ByteLength(value["stdout"]) <= MAXIMUM_TOOL_STREAM_FIELD_BYTES &&
    isBoundedIdentifier(value["streamId"])
  );
}

function hasUniqueToolStreamEntries(
  values: readonly ToolStreamEntry[],
): boolean {
  const callIds = new Set<string>();
  const indexes = new Set<number>();
  for (const value of values) {
    if (callIds.has(value.callId) || indexes.has(value.index)) {
      return false;
    }
    callIds.add(value.callId);
    indexes.add(value.index);
  }
  return true;
}

export function isToolStreamSnapshotFrame(
  value: unknown,
): value is ToolStreamSnapshotFrame {
  if (
    !isRecord(value) ||
    value["type"] !== "tool_stream_snapshot" ||
    !isBoundedIdentifier(value["sessionId"]) ||
    !isBoundedIdentifier(value["streamId"]) ||
    !Array.isArray(value["streams"]) ||
    value["streams"].length > MAXIMUM_TOOL_STREAMS_PER_SESSION
  ) {
    return false;
  }
  const streams = value["streams"];
  return (
    streams.every(
      (entry) =>
        isToolStreamEntry(entry) &&
        entry.sessionId === value["sessionId"] &&
        entry.streamId === value["streamId"] &&
        !isToolStreamTerminalState(entry.state),
    ) && hasUniqueToolStreamEntries(streams)
  );
}

function initialEntry(delta: ToolStreamDelta): ToolStreamEntry {
  return {
    arguments: "",
    callId: delta.callId,
    index: delta.index,
    name: "",
    sequence: delta.sequence,
    sessionId: delta.sessionId,
    state: "preparing",
    stderr: "",
    stdout: "",
    streamId: delta.streamId,
  };
}

const channelAppenders: Record<
  ToolStreamChannel,
  (entry: ToolStreamEntry, content: string) => ToolStreamEntry
> = {
  arguments: (entry, content) => ({
    ...entry,
    arguments: entry.arguments + content,
  }),
  name: (entry, content) => ({ ...entry, name: entry.name + content }),
  stderr: (entry, content) => ({ ...entry, stderr: entry.stderr + content }),
  stdout: (entry, content) => ({ ...entry, stdout: entry.stdout + content }),
};

function applyChannel(
  entry: ToolStreamEntry,
  channel: ToolStreamChannel,
  content: string,
): ToolStreamEntry | undefined {
  const next = channelAppenders[channel](entry, content);
  const field = next[channel];
  return utf8ByteLength(field) <= MAXIMUM_TOOL_STREAM_FIELD_BYTES
    ? next
    : undefined;
}

export function canTransitionToolStreamState(
  current: ToolStreamState | undefined,
  next: ToolStreamState,
): boolean {
  if (current === undefined) {
    return next === "preparing";
  }
  if (current === "preparing") {
    return isToolStreamTerminalState(next) || next === "running";
  }
  return current === "running" && isToolStreamTerminalState(next);
}

function isChannelTransition(
  current: ToolStreamState,
  channel: ToolStreamChannel,
): boolean {
  return current === "preparing"
    ? channel === "arguments" || channel === "name"
    : current === "running" && (channel === "stderr" || channel === "stdout");
}

export function applyToolStreamDelta(
  current: ToolStreamEntry | undefined,
  delta: ToolStreamDelta,
): ApplyToolStreamDeltaResult {
  if (!isToolStreamDelta(delta)) {
    return { accepted: false, reason: "invalid" };
  }
  if (current === undefined) {
    if (delta.sequence !== 0 || delta.state !== "preparing") {
      return { accepted: false, reason: "initial" };
    }
    return {
      accepted: true,
      entry: initialEntry(delta),
      terminal: false,
    };
  }
  const isRename = delta.previousCallId !== undefined;
  if (
    current.sessionId !== delta.sessionId ||
    current.streamId !== delta.streamId ||
    current.index !== delta.index ||
    (isRename
      ? delta.previousCallId !== current.callId ||
        delta.callId === current.callId ||
        current.state !== "preparing"
      : delta.callId !== current.callId)
  ) {
    return { accepted: false, reason: "identity" };
  }
  if (isToolStreamTerminalState(current.state)) {
    return { accepted: false, reason: "terminal" };
  }
  if (delta.sequence <= current.sequence) {
    return { accepted: false, reason: "late" };
  }
  if (delta.sequence !== current.sequence + 1) {
    return { accepted: false, reason: "gap" };
  }
  if (
    (delta.channel !== undefined &&
      !isChannelTransition(current.state, delta.channel)) ||
    (delta.state !== undefined &&
      !canTransitionToolStreamState(current.state, delta.state))
  ) {
    return { accepted: false, reason: "transition" };
  }

  let entry: ToolStreamEntry = {
    ...current,
    callId: delta.callId,
    sequence: delta.sequence,
  };
  if (delta.channel !== undefined && delta.content !== undefined) {
    const next = applyChannel(entry, delta.channel, delta.content);
    if (next === undefined) {
      return { accepted: false, reason: "bounds" };
    }
    entry = next;
  }
  if (delta.state !== undefined) {
    entry = { ...entry, state: delta.state };
  }
  return {
    accepted: true,
    entry,
    ...(delta.previousCallId === undefined
      ? {}
      : { previousCallId: delta.previousCallId }),
    terminal: isToolStreamTerminalState(entry.state),
  };
}

function createToolStreamSnapshotFrame(
  sessionId: string,
  streamId: string,
  streams: readonly ToolStreamEntry[],
): ToolStreamSnapshotFrame {
  return {
    sessionId,
    streamId,
    streams,
    type: "tool_stream_snapshot",
  };
}

interface ToolStreamSnapshotStoreOptions {
  readonly maximumStreams?: number;
  readonly sessionId: string;
}

function boundedMaximum(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return value === undefined || !Number.isSafeInteger(value)
    ? fallback
    : Math.max(1, Math.min(value, maximum));
}

export interface ToolStreamSnapshotStore {
  readonly size: number;
  apply(delta: ToolStreamDelta): boolean;
  snapshot(streamId: string): ToolStreamSnapshotFrame;
  replace(snapshot: ToolStreamSnapshotFrame): boolean;
  clear(): void;
  deleteOldest(): boolean;
}

export function createToolStreamSnapshotStore(
  options: ToolStreamSnapshotStoreOptions,
): ToolStreamSnapshotStore {
  const entries = new Map<string, ToolStreamEntry>();
  const maximumStreams = boundedMaximum(
    options.maximumStreams,
    MAXIMUM_TOOL_STREAMS_PER_SESSION,
    MAXIMUM_TOOL_STREAMS_PER_SESSION,
  );
  const sessionId = options.sessionId;

  const deleteOldest = (): boolean => {
    const oldest = entries.keys().next().value;
    return oldest === undefined ? false : entries.delete(oldest);
  };

  const trim = (): void => {
    while (entries.size > maximumStreams) {
      if (!deleteOldest()) {
        return;
      }
    }
  };

  return {
    get size(): number {
      return entries.size;
    },

    apply(delta): boolean {
      if (delta.sessionId !== sessionId) {
        return false;
      }
      const key = entryKey(delta.streamId, delta.index);
      const currentKey = entries.has(key) ? key : undefined;
      const current =
        currentKey === undefined ? undefined : entries.get(currentKey);
      const result = applyToolStreamDelta(current, delta);
      if (!result.accepted) {
        return false;
      }
      if (currentKey !== undefined) {
        entries.delete(currentKey);
      }
      if (!result.terminal) {
        entries.set(
          entryKey(result.entry.streamId, result.entry.index),
          result.entry,
        );
        trim();
      }
      return true;
    },

    snapshot(streamId): ToolStreamSnapshotFrame {
      return createToolStreamSnapshotFrame(
        sessionId,
        streamId,
        [...entries.values()].filter((entry) => entry.streamId === streamId),
      );
    },

    replace(snapshot): boolean {
      if (
        snapshot.sessionId !== sessionId ||
        !isToolStreamSnapshotFrame(snapshot)
      ) {
        return false;
      }
      const reconciled = snapshot.streams.map((entry) => {
        const current = entries.get(entryKey(entry.streamId, entry.index));
        return current !== undefined && current.sequence > entry.sequence
          ? current
          : { ...entry };
      });
      for (const [key, entry] of entries) {
        if (entry.streamId === snapshot.streamId) {
          entries.delete(key);
        }
      }
      for (const entry of reconciled) {
        entries.set(entryKey(entry.streamId, entry.index), entry);
      }
      trim();
      return true;
    },

    clear(): void {
      entries.clear();
    },

    deleteOldest,
  };
}

export interface ToolStreamHubStateOptions {
  readonly maximumStreamsPerSession?: number;
  readonly maximumStreamsPerUser?: number;
}

interface UserToolStreamState {
  readonly sessions: Map<string, ToolStreamSnapshotStore>;
  size: number;
}

export class ToolStreamHubState {
  readonly #maximumStreamsPerSession: number;
  readonly #maximumStreamsPerUser: number;
  readonly #users = new Map<string, UserToolStreamState>();

  constructor(options: ToolStreamHubStateOptions = {}) {
    this.#maximumStreamsPerSession = boundedMaximum(
      options.maximumStreamsPerSession,
      MAXIMUM_TOOL_STREAMS_PER_SESSION,
      MAXIMUM_TOOL_STREAMS_PER_SESSION,
    );
    this.#maximumStreamsPerUser = boundedMaximum(
      options.maximumStreamsPerUser,
      MAXIMUM_TOOL_STREAMS_PER_USER,
      MAXIMUM_TOOL_STREAMS_PER_USER,
    );
  }

  #user(userId: string): UserToolStreamState | undefined {
    if (!isBoundedIdentifier(userId)) {
      return undefined;
    }
    return (
      this.#users.get(userId) ?? {
        sessions: new Map<string, ToolStreamSnapshotStore>(),
        size: 0,
      }
    );
  }

  #store(
    user: UserToolStreamState,
    sessionId: string,
  ): {
    readonly existing: ToolStreamSnapshotStore | undefined;
    readonly store: ToolStreamSnapshotStore;
  } {
    const existing = user.sessions.get(sessionId);
    return {
      existing,
      store:
        existing ??
        createToolStreamSnapshotStore({
          maximumStreams: this.#maximumStreamsPerSession,
          sessionId,
        }),
    };
  }

  #storeUser(userId: string, user: UserToolStreamState): void {
    if (user.size > 0) {
      this.#users.set(userId, user);
      return;
    }
    this.#users.delete(userId);
  }

  #commit(
    userId: string,
    user: UserToolStreamState,
    sessionId: string,
    store: ToolStreamSnapshotStore,
    before: number,
  ): void {
    user.size += store.size - before;
    if (store.size === 0) {
      user.sessions.delete(sessionId);
    } else {
      user.sessions.set(sessionId, store);
    }
    this.#trim(user);
    this.#storeUser(userId, user);
  }

  apply(userId: string, delta: ToolStreamDelta): boolean {
    const user = this.#user(userId);
    if (user === undefined) {
      return false;
    }
    const { store } = this.#store(user, delta.sessionId);
    const before = store.size;
    if (!store.apply(delta)) {
      return false;
    }
    this.#commit(userId, user, delta.sessionId, store, before);
    return true;
  }

  snapshot(
    userId: string,
    sessionId: string,
    streamId: string,
  ): ToolStreamSnapshotFrame {
    return (
      this.#users.get(userId)?.sessions.get(sessionId)?.snapshot(streamId) ??
      createToolStreamSnapshotFrame(sessionId, streamId, [])
    );
  }

  replace(userId: string, snapshot: ToolStreamSnapshotFrame): boolean {
    const user = this.#user(userId);
    if (user === undefined || !isToolStreamSnapshotFrame(snapshot)) {
      return false;
    }
    const { store } = this.#store(user, snapshot.sessionId);
    const before = store.size;
    if (!store.replace(snapshot)) {
      return false;
    }
    this.#commit(userId, user, snapshot.sessionId, store, before);
    return true;
  }

  clearSession(userId: string, sessionId: string): void {
    const user = this.#users.get(userId);
    const store = user?.sessions.get(sessionId);
    if (user === undefined || store === undefined) {
      return;
    }
    user.size -= store.size;
    store.clear();

    user.sessions.delete(sessionId);
    this.#storeUser(userId, user);
  }

  clearUser(userId: string): void {
    this.#users.delete(userId);
  }

  #trim(user: UserToolStreamState): void {
    while (user.size > this.#maximumStreamsPerUser) {
      const oldestSessionId = user.sessions.keys().next().value;
      if (oldestSessionId === undefined) {
        user.size = 0;
        return;
      }
      const oldestStore = user.sessions.get(oldestSessionId);
      if (!oldestStore?.deleteOldest()) {
        user.sessions.delete(oldestSessionId);
        continue;
      }
      user.size -= 1;
      if (oldestStore.size === 0) {
        user.sessions.delete(oldestSessionId);
      }
    }
  }
}

function entryKey(streamId: string, index: number): string {
  return `${streamId}\u0000${String(index)}`;
}
