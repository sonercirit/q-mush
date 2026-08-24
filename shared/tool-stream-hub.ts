import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
} from "./tool-stream-limits.ts";
import {
  applyToolStreamDelta,
  createToolStreamSnapshotFrame,
  isBoundedIdentifier,
  isToolStreamSnapshotFrame,
  type ToolStreamDelta,
  type ToolStreamEntry,
  type ToolStreamSnapshotFrame,
} from "./tool-stream.ts";

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

interface ToolStreamSnapshotStore {
  readonly size: number;
  apply(delta: ToolStreamDelta): boolean;
  snapshot(streamId: string): ToolStreamSnapshotFrame;
  replace(snapshot: ToolStreamSnapshotFrame): boolean;
  clear(): void;
  deleteOldest(): boolean;
}

function createToolStreamSnapshotStore(
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

export type ToolStreamHubStateOptions = Partial<{
  maximumStreamsPerSession: number;
  maximumStreamsPerUser: number;
}>;

interface UserToolStreamState {
  readonly sessions: Map<string, ToolStreamSnapshotStore>;
  size: number;
}

export interface ToolStreamHubState {
  apply(userId: string, delta: ToolStreamDelta): boolean;
  snapshot(
    userId: string,
    sessionId: string,
    streamId: string,
  ): ToolStreamSnapshotFrame;
  replace(userId: string, snapshot: ToolStreamSnapshotFrame): boolean;
  clearSession(userId: string, sessionId: string): void;
  clearUser(userId: string): void;
}

export function createToolStreamHubState(
  options: ToolStreamHubStateOptions = {},
): ToolStreamHubState {
  const maximumStreamsPerSession = boundedMaximum(
    options.maximumStreamsPerSession,
    MAXIMUM_TOOL_STREAMS_PER_SESSION,
    MAXIMUM_TOOL_STREAMS_PER_SESSION,
  );
  const maximumStreamsPerUser = boundedMaximum(
    options.maximumStreamsPerUser,
    MAXIMUM_TOOL_STREAMS_PER_USER,
    MAXIMUM_TOOL_STREAMS_PER_USER,
  );
  const users = new Map<string, UserToolStreamState>();

  const getUser = (userId: string): UserToolStreamState | undefined => {
    if (!isBoundedIdentifier(userId)) {
      return undefined;
    }
    return (
      users.get(userId) ?? {
        sessions: new Map<string, ToolStreamSnapshotStore>(),
        size: 0,
      }
    );
  };

  const getStore = (
    user: UserToolStreamState,
    sessionId: string,
  ): ToolStreamSnapshotStore =>
    user.sessions.get(sessionId) ??
    createToolStreamSnapshotStore({
      maximumStreams: maximumStreamsPerSession,
      sessionId,
    });

  const storeUser = (userId: string, user: UserToolStreamState): void => {
    if (user.size > 0) {
      users.set(userId, user);
    } else {
      users.delete(userId);
    }
  };

  const trim = (user: UserToolStreamState): void => {
    while (user.size > maximumStreamsPerUser) {
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
  };

  const commit = (
    userId: string,
    user: UserToolStreamState,
    sessionId: string,
    snapshotStore: ToolStreamSnapshotStore,
    before: number,
  ): void => {
    user.size += snapshotStore.size - before;
    if (snapshotStore.size === 0) {
      user.sessions.delete(sessionId);
    } else {
      user.sessions.set(sessionId, snapshotStore);
    }
    trim(user);
    storeUser(userId, user);
  };

  return {
    apply(userId, delta): boolean {
      const user = getUser(userId);
      if (user === undefined) {
        return false;
      }
      const snapshotStore = getStore(user, delta.sessionId);
      const before = snapshotStore.size;
      if (!snapshotStore.apply(delta)) {
        return false;
      }
      commit(userId, user, delta.sessionId, snapshotStore, before);
      return true;
    },

    snapshot(userId, sessionId, streamId): ToolStreamSnapshotFrame {
      return (
        users.get(userId)?.sessions.get(sessionId)?.snapshot(streamId) ??
        createToolStreamSnapshotFrame(sessionId, streamId, [])
      );
    },

    replace(userId, snapshot): boolean {
      const user = getUser(userId);
      if (user === undefined || !isToolStreamSnapshotFrame(snapshot)) {
        return false;
      }
      const snapshotStore = getStore(user, snapshot.sessionId);
      const before = snapshotStore.size;
      if (!snapshotStore.replace(snapshot)) {
        return false;
      }
      commit(userId, user, snapshot.sessionId, snapshotStore, before);
      return true;
    },

    clearSession(userId, sessionId): void {
      const user = users.get(userId);
      const snapshotStore = user?.sessions.get(sessionId);
      if (user === undefined || snapshotStore === undefined) {
        return;
      }
      user.size -= snapshotStore.size;
      snapshotStore.clear();
      user.sessions.delete(sessionId);
      storeUser(userId, user);
    },

    clearUser(userId): void {
      users.delete(userId);
    },
  };
}

function entryKey(streamId: string, index: number): string {
  return `${streamId}\u0000${String(index)}`;
}
