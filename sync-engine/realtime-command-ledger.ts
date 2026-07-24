import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  RealtimeCommandError,
  type UserRealtimeCommand,
} from "../shared/user-realtime-protocol.ts";

export { RealtimeCommandError as RealtimeCommandFailure };

const MAXIMUM_COMMAND_RESULT_LENGTH = 128 * 1024 * 1024;
const DEFAULT_MAXIMUM_COMPLETED_RESULT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAXIMUM_PENDING_ENTRIES = 100;

interface RealtimeCommandSuccess {
  readonly commandId: string;
  readonly result: unknown;
  readonly type: "command_success";
}

interface RealtimeCommandErrorAcknowledgement {
  readonly commandId: string;
  readonly error: string;
  readonly type: "command_error";
}

export type RealtimeCommandAcknowledgement =
  RealtimeCommandErrorAcknowledgement | RealtimeCommandSuccess;

interface LedgerEntry {
  readonly commandDigest: string;
  readonly commandId: string;
  completedBytes: number;
  readonly idempotencyKey: string;
  expiresAt: number;
  readonly result: Promise<
    | { readonly result: unknown; readonly type: "command_success" }
    | { readonly error: string; readonly type: "command_error" }
  >;
}

function commandFingerprint(command: UserRealtimeCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: command.operation,
        payload: command.payload,
      }),
    )
    .digest("base64url");
}

function safeResult(
  result: unknown,
  maximumResultBytes: number,
): {
  readonly bytes: number;
  readonly result: unknown;
} {
  let serialized: string;
  try {
    const value = JSON.stringify(result);
    if (typeof value !== "string") {
      throw new RealtimeCommandError("command_failed");
    }
    serialized = value;
  } catch {
    throw new RealtimeCommandError("command_failed");
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maximumResultBytes) {
    throw new RealtimeCommandError("command_result_too_large");
  }
  return { bytes, result };
}

function safeError(error: unknown): string {
  return error instanceof RealtimeCommandError ? error.code : "command_failed";
}

interface RealtimeCommandLedgerOptions {
  readonly maximumCompletedResultBytes?: number;
  readonly maximumEntries?: number;
  readonly maximumPendingEntries?: number;
  readonly maximumResultBytes?: number;
  readonly now?: () => number;
  readonly retentionMs?: number;
}

export class RealtimeCommandLedger {
  readonly #commandIds = new Map<string, Map<string, string>>();
  #completedResultBytes = 0;
  readonly #entries = new Map<string, Map<string, LedgerEntry>>();
  readonly #maximumCompletedResultBytes: number;
  readonly #maximumEntries: number;
  readonly #maximumPendingEntries: number;
  readonly #maximumResultBytes: number;
  readonly #now: () => number;
  #pendingEntries = 0;
  readonly #retentionMs: number;

  constructor(options: RealtimeCommandLedgerOptions = {}) {
    this.#maximumCompletedResultBytes =
      options.maximumCompletedResultBytes ??
      DEFAULT_MAXIMUM_COMPLETED_RESULT_BYTES;
    this.#maximumEntries = options.maximumEntries ?? 10_000;
    this.#maximumPendingEntries =
      options.maximumPendingEntries ?? DEFAULT_MAXIMUM_PENDING_ENTRIES;
    this.#maximumResultBytes =
      options.maximumResultBytes ?? MAXIMUM_COMMAND_RESULT_LENGTH;
    if (
      this.#maximumCompletedResultBytes < 1 ||
      this.#maximumEntries < 1 ||
      this.#maximumPendingEntries < 1 ||
      this.#maximumResultBytes < 1
    ) {
      throw new RangeError("Realtime command ledger limits must be positive");
    }
    this.#now = options.now ?? Date.now;
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000;
  }

  #deleteEntry(userId: string, idempotencyKey: string): void {
    const userEntries = this.#entries.get(userId);
    if (userEntries === undefined) {
      return;
    }
    const entry = userEntries.get(idempotencyKey);
    if (entry === undefined) {
      return;
    }
    userEntries.delete(idempotencyKey);
    this.#completedResultBytes -= entry.completedBytes;
    if (userEntries.size === 0) {
      this.#entries.delete(userId);
    }
    const userCommandIds = this.#commandIds.get(userId);
    userCommandIds?.delete(entry.commandId);
    if (userCommandIds?.size === 0) {
      this.#commandIds.delete(userId);
    }
  }

  #entriesCount(): number {
    let count = 0;
    for (const entries of this.#entries.values()) {
      count += entries.size;
    }
    return count;
  }

  #completedEntries(): IterableIterator<
    readonly [userId: string, idempotencyKey: string]
  > {
    return this.#matchingEntries(
      ({ expiresAt }) => expiresAt !== Number.POSITIVE_INFINITY,
    );
  }

  *#matchingEntries(
    matches: (entry: LedgerEntry) => boolean,
  ): IterableIterator<readonly [userId: string, idempotencyKey: string]> {
    for (const [userId, entries] of this.#entries) {
      for (const [idempotencyKey, entry] of entries) {
        if (matches(entry)) {
          yield [userId, idempotencyKey];
        }
      }
    }
  }

  #pruneExpired(now: number): void {
    for (const entry of this.#matchingEntries(
      ({ expiresAt }) => expiresAt <= now,
    )) {
      this.#deleteEntry(...entry);
    }
  }

  #oldestCompletedEntry():
    readonly [userId: string, idempotencyKey: string] | undefined {
    const next = this.#completedEntries().next();
    return next.done === true ? undefined : next.value;
  }

  #evictOverLimit(): void {
    let oldest = this.#oldestCompletedEntry();
    while (
      oldest !== undefined &&
      (this.#entriesCount() > this.#maximumEntries ||
        this.#completedResultBytes > this.#maximumCompletedResultBytes)
    ) {
      this.#deleteEntry(...oldest);
      oldest = this.#oldestCompletedEntry();
    }
  }

  #makeRoom(): boolean {
    while (this.#entriesCount() >= this.#maximumEntries) {
      const oldest = this.#oldestCompletedEntry();
      if (oldest === undefined) {
        return false;
      }
      this.#deleteEntry(...oldest);
    }
    return true;
  }

  async execute(
    userId: string,
    command: UserRealtimeCommand,
    execute: () => unknown,
  ): Promise<RealtimeCommandAcknowledgement> {
    const now = this.#now();
    this.#pruneExpired(now);
    const fingerprint = commandFingerprint(command);
    const existing = this.#entries.get(userId)?.get(command.idempotencyKey);
    const commandIdEntryKey = this.#commandIds
      .get(userId)
      ?.get(command.commandId);

    if (
      commandIdEntryKey !== undefined &&
      commandIdEntryKey !== command.idempotencyKey
    ) {
      return {
        commandId: command.commandId,
        error: "command_id_conflict",
        type: "command_error",
      };
    }

    if (existing !== undefined && existing.commandDigest !== fingerprint) {
      return {
        commandId: command.commandId,
        error: "idempotency_conflict",
        type: "command_error",
      };
    }

    if (
      existing === undefined &&
      (this.#pendingEntries >= this.#maximumPendingEntries || !this.#makeRoom())
    ) {
      return {
        commandId: command.commandId,
        error: "command_capacity_exceeded",
        type: "command_error",
      };
    }

    const entry =
      existing ??
      (() => {
        this.#pendingEntries += 1;
        const created: LedgerEntry = {
          commandDigest: fingerprint,
          commandId: command.commandId,
          completedBytes: 0,
          expiresAt: Number.POSITIVE_INFINITY,
          idempotencyKey: command.idempotencyKey,
          result: Promise.resolve()
            .then(execute)
            .then((result) => safeResult(result, this.#maximumResultBytes))
            .then(
              ({ bytes, result }) => {
                created.completedBytes = bytes;
                return { result, type: "command_success" as const };
              },
              (error: unknown) => ({
                error: safeError(error),
                type: "command_error" as const,
              }),
            ),
        };
        void created.result.then(() => {
          this.#pendingEntries -= 1;
          created.expiresAt = this.#now() + this.#retentionMs;
          if (
            this.#entries.get(userId)?.get(command.idempotencyKey) === created
          ) {
            this.#completedResultBytes += created.completedBytes;
            this.#evictOverLimit();
          }
        });
        const userEntries =
          this.#entries.get(userId) ?? new Map<string, LedgerEntry>();
        userEntries.set(command.idempotencyKey, created);
        this.#entries.set(userId, userEntries);
        const userCommandIds =
          this.#commandIds.get(userId) ?? new Map<string, string>();
        userCommandIds.set(command.commandId, command.idempotencyKey);
        this.#commandIds.set(userId, userCommandIds);
        return created;
      })();
    const result = await entry.result;
    return { commandId: command.commandId, ...result };
  }
}
