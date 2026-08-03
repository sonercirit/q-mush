import { createHash } from "node:crypto";
import type { UserRealtimeCommand } from "../shared/user-realtime-protocol.ts";
import { utf8ByteLength } from "../shared/utf8.ts";
import {
  commandExecution,
  commandRequiresDurableReceipt,
  resultBodyBytes,
  type CommandExecution,
  type CommandResult,
} from "./realtime-command-execution.ts";

export { RealtimeCommandError as RealtimeCommandFailure } from "../shared/user-realtime-protocol.ts";

const MAXIMUM_COMMAND_RESULT_LENGTH = 128 * 1024 * 1024;
const DEFAULT_MAXIMUM_COMPLETED_RESULT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAXIMUM_COMPLETED_RESULT_BYTES_PER_USER = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_COMPLETED_RESULTS = 1_000;
const DEFAULT_MAXIMUM_COMPLETED_RESULTS_PER_USER = 100;
const DEFAULT_MAXIMUM_ENTRIES = 10_000;
const DEFAULT_MAXIMUM_ENTRIES_PER_USER = 1_000;
const DEFAULT_MAXIMUM_PENDING_BYTES_PER_USER = 256 * 1024 * 1024;
const DEFAULT_MAXIMUM_PENDING_ENTRIES = 1_000;
const DEFAULT_MAXIMUM_PENDING_ENTRIES_PER_USER = 100;
const UNKNOWN_REPLAY_OUTCOME = "command_outcome_unknown";
const RECEIPT_CAPACITY_EXCEEDED = "command_receipt_capacity_exceeded";

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

type RealtimeCommandAcknowledgement =
  RealtimeCommandErrorAcknowledgement | RealtimeCommandSuccess;

export interface SerializedRealtimeAcknowledgement {
  readonly serialized: string;
  readonly value: RealtimeCommandAcknowledgement;
}

function acknowledgement(
  value: RealtimeCommandAcknowledgement,
): SerializedRealtimeAcknowledgement {
  return { serialized: JSON.stringify(value), value };
}

interface LedgerEntry {
  readonly commandDigest: string;
  readonly commandId: string;
  completedAcknowledgement: SerializedRealtimeAcknowledgement | undefined;
  completedBytes: number;
  completionOrder: bigint | undefined;
  expiresAt: number;
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly pendingBytes: number;
  readonly result: Promise<CommandResult>;
  retainedResult: CommandResult | undefined;
  readonly userId: string;
}

interface CompletedUserUsage {
  bytes: number;
  results: number;
}

interface RealtimeCommandLedgerOptions {
  readonly maximumCompletedResultBytes?: number;
  readonly maximumCompletedResultBytesPerUser?: number;
  readonly maximumCompletedResults?: number;
  readonly maximumCompletedResultsPerUser?: number;
  readonly maximumEntries?: number;
  readonly maximumEntriesPerUser?: number;
  readonly maximumPendingBytesPerUser?: number;
  readonly maximumPendingEntries?: number;
  readonly maximumPendingEntriesPerOperation?: Readonly<
    Partial<Record<string, number>>
  >;
  readonly maximumPendingEntriesPerUser?: number;
  readonly maximumResultBytes?: number;
  readonly now?: () => number;
  readonly payloadBytes?: (command: UserRealtimeCommand) => number;
  readonly retentionMs?: number;
}

function commandFingerprint(command: UserRealtimeCommand): string | undefined {
  try {
    const serialized = JSON.stringify({
      operation: command.operation,
      payload: command.payload,
    });
    if (typeof serialized !== "string") {
      return undefined;
    }
    return createHash("sha256").update(serialized).digest("base64url");
  } catch {
    return undefined;
  }
}

function defaultPayloadBytes(command: UserRealtimeCommand): number {
  try {
    const serialized = JSON.stringify(command.payload);
    return typeof serialized === "string"
      ? utf8ByteLength(serialized)
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function positiveLimit(limit: number | undefined): boolean {
  return limit === undefined || (Number.isSafeInteger(limit) && limit >= 1);
}

export class RealtimeCommandLedger {
  readonly #commandIds = new Map<string, Map<string, LedgerEntry>>();
  #completedResultBytes = 0;
  readonly #completedUsers = new Map<string, CompletedUserUsage>();
  readonly #entries = new Map<string, Map<string, LedgerEntry>>();
  readonly #maximumCompletedResultBytes: number;
  readonly #maximumCompletedResultBytesPerUser: number;
  readonly #maximumCompletedResults: number;
  readonly #maximumCompletedResultsPerUser: number;
  readonly #maximumEntries: number;
  readonly #maximumEntriesPerUser: number;
  readonly #maximumPendingBytesPerUser: number;
  readonly #maximumPendingEntries: number;
  readonly #maximumPendingEntriesPerOperation:
    Readonly<Partial<Record<string, number>>> | undefined;
  readonly #maximumPendingEntriesPerUser: number;
  readonly #maximumResultBytes: number;
  #nextCompletionOrder = 0n;
  readonly #now: () => number;
  readonly #payloadBytes: (command: UserRealtimeCommand) => number;
  #pendingEntries = 0;
  readonly #pendingUsers = new Map<
    string,
    { bytes: number; entries: number; operations: Map<string, number> }
  >();
  readonly #retentionMs: number;

  constructor(options: RealtimeCommandLedgerOptions = {}) {
    this.#maximumCompletedResultBytes =
      options.maximumCompletedResultBytes ??
      DEFAULT_MAXIMUM_COMPLETED_RESULT_BYTES;
    this.#maximumCompletedResultBytesPerUser =
      options.maximumCompletedResultBytesPerUser ??
      DEFAULT_MAXIMUM_COMPLETED_RESULT_BYTES_PER_USER;
    this.#maximumCompletedResults =
      options.maximumCompletedResults ?? DEFAULT_MAXIMUM_COMPLETED_RESULTS;
    this.#maximumCompletedResultsPerUser =
      options.maximumCompletedResultsPerUser ??
      DEFAULT_MAXIMUM_COMPLETED_RESULTS_PER_USER;
    this.#maximumEntries = options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
    this.#maximumEntriesPerUser =
      options.maximumEntriesPerUser ?? DEFAULT_MAXIMUM_ENTRIES_PER_USER;
    this.#maximumPendingBytesPerUser =
      options.maximumPendingBytesPerUser ??
      DEFAULT_MAXIMUM_PENDING_BYTES_PER_USER;
    this.#maximumPendingEntries =
      options.maximumPendingEntries ?? DEFAULT_MAXIMUM_PENDING_ENTRIES;
    this.#maximumPendingEntriesPerOperation =
      options.maximumPendingEntriesPerOperation === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(options.maximumPendingEntriesPerOperation),
          );
    this.#maximumPendingEntriesPerUser =
      options.maximumPendingEntriesPerUser ??
      DEFAULT_MAXIMUM_PENDING_ENTRIES_PER_USER;
    this.#maximumResultBytes =
      options.maximumResultBytes ?? MAXIMUM_COMMAND_RESULT_LENGTH;
    this.#now = options.now ?? Date.now;
    this.#payloadBytes = options.payloadBytes ?? defaultPayloadBytes;
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000;

    const operationLimits = Object.entries(
      this.#maximumPendingEntriesPerOperation ?? {},
    );
    if (
      !positiveLimit(this.#maximumCompletedResultBytes) ||
      !positiveLimit(this.#maximumCompletedResultBytesPerUser) ||
      !positiveLimit(this.#maximumCompletedResults) ||
      !positiveLimit(this.#maximumCompletedResultsPerUser) ||
      !positiveLimit(this.#maximumEntries) ||
      !positiveLimit(this.#maximumEntriesPerUser) ||
      !positiveLimit(this.#maximumPendingBytesPerUser) ||
      !positiveLimit(this.#maximumPendingEntries) ||
      !positiveLimit(this.#maximumPendingEntriesPerUser) ||
      !positiveLimit(this.#maximumResultBytes) ||
      !positiveLimit(this.#retentionMs) ||
      typeof this.#now !== "function" ||
      typeof this.#payloadBytes !== "function" ||
      !operationLimits.every(
        ([operation, limit]) =>
          /^[a-z][a-z\d_]*(?:\.[a-z][a-z\d_]*){1,7}$/u.test(operation) &&
          positiveLimit(limit),
      )
    ) {
      throw new RangeError("Realtime command ledger limits must be positive");
    }
  }

  #deleteEntry(
    userId: string,
    idempotencyKey: string,
    entry: LedgerEntry,
  ): void {
    const userCommandIds = this.#commandIds.get(userId);
    const userEntries = this.#entries.get(userId);
    if (
      userCommandIds?.get(entry.commandId) !== entry ||
      userEntries?.get(idempotencyKey) !== entry
    ) {
      return;
    }
    userCommandIds.delete(entry.commandId);
    userEntries.delete(idempotencyKey);
    this.#removeRetainedResult(entry);
    if (userCommandIds.size === 0) {
      this.#commandIds.delete(userId);
    }
    if (userEntries.size === 0) {
      this.#entries.delete(userId);
    }
  }

  #removeRetainedResult(entry: LedgerEntry): void {
    const completionOrder = entry.completionOrder;
    if (completionOrder === undefined || entry.retainedResult === undefined) {
      return;
    }
    this.#completedResultBytes -= entry.completedBytes;
    const user = this.#completedUsers.get(entry.userId);
    if (user !== undefined) {
      user.bytes -= entry.completedBytes;
      user.results -= 1;
      if (user.results === 0) {
        this.#completedUsers.delete(entry.userId);
      }
    }
    entry.completedBytes = 0;
    entry.completedAcknowledgement = undefined;
    entry.completionOrder = undefined;
    entry.retainedResult = undefined;
  }

  *#matchingEntries(
    matches: (entry: LedgerEntry) => boolean,
  ): IterableIterator<
    readonly [userId: string, idempotencyKey: string, entry: LedgerEntry]
  > {
    for (const [userId, entries] of this.#entries) {
      for (const [idempotencyKey, entry] of entries) {
        if (matches(entry)) {
          yield [userId, idempotencyKey, entry];
        }
      }
    }
  }

  #pruneExpired(now: number): void {
    const expired = new Array<
      readonly [userId: string, idempotencyKey: string, entry: LedgerEntry]
    >();
    for (const entry of this.#matchingEntries(
      ({ expiresAt }) => expiresAt <= now,
    )) {
      expired.push(entry);
    }
    for (const entry of expired) {
      this.#deleteEntry(...entry);
    }
  }

  #oldestRetainedResult(userId?: string): LedgerEntry | undefined {
    let oldest: LedgerEntry | undefined;
    for (const [, , entry] of this.#matchingEntries(
      ({ retainedResult }) => retainedResult !== undefined,
    )) {
      if (userId !== undefined && entry.userId !== userId) {
        continue;
      }
      if (
        oldest?.completionOrder === undefined ||
        (entry.completionOrder !== undefined &&
          entry.completionOrder < oldest.completionOrder)
      ) {
        oldest = entry;
      }
    }
    return oldest;
  }

  #evictResultBodies(userId: string): void {
    let user = this.#completedUsers.get(userId);
    while (
      user !== undefined &&
      (user.bytes > this.#maximumCompletedResultBytesPerUser ||
        user.results > this.#maximumCompletedResultsPerUser)
    ) {
      const oldest = this.#oldestRetainedResult(userId);
      if (oldest === undefined) {
        break;
      }
      this.#removeRetainedResult(oldest);
      user = this.#completedUsers.get(userId);
    }

    let oldest = this.#oldestRetainedResult();
    while (oldest !== undefined) {
      let retainedResults = 0;
      const results = this.#matchingEntries(
        ({ retainedResult }) => retainedResult !== undefined,
      );
      while (!results.next().done) {
        retainedResults += 1;
      }
      if (
        this.#completedResultBytes <= this.#maximumCompletedResultBytes &&
        retainedResults <= this.#maximumCompletedResults
      ) {
        break;
      }
      this.#removeRetainedResult(oldest);
      oldest = this.#oldestRetainedResult();
    }
  }

  #canStart(userId: string, operation: string, payloadBytes: number): boolean {
    const user = this.#pendingUsers.get(userId);
    const operationLimit = this.#maximumPendingEntriesPerOperation?.[operation];
    return (
      this.#pendingEntries < this.#maximumPendingEntries &&
      (user?.entries ?? 0) < this.#maximumPendingEntriesPerUser &&
      Number.isSafeInteger(payloadBytes) &&
      payloadBytes >= 0 &&
      payloadBytes <= this.#maximumPendingBytesPerUser - (user?.bytes ?? 0) &&
      (operationLimit === undefined ||
        (user?.operations.get(operation) ?? 0) < operationLimit)
    );
  }

  #addPending(userId: string, operation: string, payloadBytes: number): void {
    const user = this.#pendingUsers.get(userId) ?? {
      bytes: 0,
      entries: 0,
      operations: new Map<string, number>(),
    };
    user.bytes += payloadBytes;
    user.entries += 1;
    user.operations.set(operation, (user.operations.get(operation) ?? 0) + 1);
    this.#pendingUsers.set(userId, user);
    this.#pendingEntries += 1;
  }

  #removePending(
    userId: string,
    operation: string,
    payloadBytes: number,
  ): void {
    const user = this.#pendingUsers.get(userId);
    if (user === undefined) {
      return;
    }
    user.bytes -= payloadBytes;
    user.entries -= 1;
    const operationEntries = (user.operations.get(operation) ?? 1) - 1;
    if (operationEntries === 0) {
      user.operations.delete(operation);
    } else {
      user.operations.set(operation, operationEntries);
    }
    if (user.entries === 0) {
      this.#pendingUsers.delete(userId);
    }
    this.#pendingEntries -= 1;
  }

  #completionExpiry(): number {
    const completedAt = this.#nowValue();
    if (completedAt === undefined || !Number.isSafeInteger(completedAt)) {
      return Number.POSITIVE_INFINITY;
    }
    const expiresAt = completedAt + this.#retentionMs;
    return Number.isSafeInteger(expiresAt)
      ? expiresAt
      : Number.POSITIVE_INFINITY;
  }

  #retainResult(entry: LedgerEntry, result: CommandResult): void {
    const bytes = resultBodyBytes(result);
    this.#nextCompletionOrder += 1n;
    entry.completedBytes = bytes;
    entry.completionOrder = this.#nextCompletionOrder;
    entry.retainedResult = result;
    this.#completedResultBytes += bytes;
    const user = this.#completedUsers.get(entry.userId) ?? {
      bytes: 0,
      results: 0,
    };
    user.bytes += bytes;
    user.results += 1;
    this.#completedUsers.set(entry.userId, user);
    this.#evictResultBodies(entry.userId);
  }

  #complete(
    entry: LedgerEntry,
    execution: CommandExecution,
    result: CommandResult,
  ): void {
    try {
      entry.completedAcknowledgement = acknowledgement({
        commandId: entry.commandId,
        ...result,
      });
      this.#removePending(entry.userId, entry.operation, entry.pendingBytes);
      if (commandRequiresDurableReceipt(entry.operation)) {
        entry.expiresAt = this.#completionExpiry();
        this.#retainResult(entry, result);
      } else {
        // Later retries execute a fresh read and cannot consume mutation slots.
        this.#deleteEntry(entry.userId, entry.idempotencyKey, entry);
      }
    } finally {
      execution.resolveCompletion();
    }
  }

  #error(commandId: string, error: string): SerializedRealtimeAcknowledgement {
    return acknowledgement({ commandId, error, type: "command_error" });
  }

  #replay(
    command: UserRealtimeCommand,
    commandDigest: string | undefined,
    entry: LedgerEntry,
  ):
    | SerializedRealtimeAcknowledgement
    | Promise<SerializedRealtimeAcknowledgement> {
    if (commandDigest === undefined || entry.commandDigest !== commandDigest) {
      return this.#error(command.commandId, "idempotency_conflict");
    }
    if (entry.completedAcknowledgement !== undefined) {
      const completed = entry.completedAcknowledgement.value;
      return command.commandId === entry.commandId
        ? entry.completedAcknowledgement
        : acknowledgement({
            commandId: command.commandId,
            ...(completed.type === "command_success"
              ? { result: completed.result, type: completed.type }
              : { error: completed.error, type: completed.type }),
          });
    }
    const replayedCommand: Promise<CommandResult | undefined> =
      entry.expiresAt === Number.POSITIVE_INFINITY
        ? entry.result
        : Promise.resolve(entry.retainedResult);
    return replayedCommand.then((result) =>
      acknowledgement({
        commandId: command.commandId,
        ...(result ?? {
          error: UNKNOWN_REPLAY_OUTCOME,
          type: "command_error" as const,
        }),
      }),
    );
  }

  #nowValue(): number | undefined {
    try {
      return this.#now();
    } catch {
      return undefined;
    }
  }

  async execute(
    userId: string,
    command: UserRealtimeCommand,
    execute: () => unknown,
  ): Promise<SerializedRealtimeAcknowledgement> {
    const admittedAt = this.#nowValue();
    if (
      admittedAt === undefined ||
      !Number.isSafeInteger(admittedAt) ||
      userId.length === 0
    ) {
      return this.#error(command.commandId, "command_capacity_exceeded");
    }
    this.#pruneExpired(admittedAt);
    const userEntries = this.#entries.get(userId);
    const existing = userEntries?.get(command.idempotencyKey);
    const commandDigest = commandFingerprint(command);
    const commandIdEntry = this.#commandIds.get(userId)?.get(command.commandId);
    if (commandIdEntry !== undefined) {
      if (commandIdEntry !== existing) {
        return this.#error(command.commandId, "command_id_conflict");
      }
      return this.#replay(command, commandDigest, commandIdEntry);
    }
    if (existing !== undefined) {
      return this.#replay(command, commandDigest, existing);
    }

    let payloadBytes: number | undefined;
    try {
      payloadBytes = this.#payloadBytes(command);
    } catch {
      payloadBytes = undefined;
    }
    if (commandDigest === undefined) {
      return this.#error(command.commandId, "invalid_command");
    }
    if (payloadBytes === undefined || !Number.isSafeInteger(payloadBytes)) {
      return this.#error(command.commandId, "command_capacity_exceeded");
    }
    const admission = this.#admission(userId, command.operation, payloadBytes);
    if (admission !== undefined) {
      // No mutation ran, so a lost rejection may be retried with the exact
      // envelope and admitted later; the rejection reserves nothing.
      return this.#error(command.commandId, admission);
    }

    this.#addPending(userId, command.operation, payloadBytes);
    let execution: CommandExecution;
    try {
      execution = commandExecution(execute, this.#maximumResultBytes);
    } catch {
      this.#removePending(userId, command.operation, payloadBytes);
      return this.#error(command.commandId, "command_failed");
    }
    const created: LedgerEntry = {
      commandDigest,
      commandId: command.commandId,
      completedAcknowledgement: undefined,
      completedBytes: 0,
      completionOrder: undefined,
      expiresAt: Number.POSITIVE_INFINITY,
      idempotencyKey: command.idempotencyKey,
      operation: command.operation,
      pendingBytes: payloadBytes,
      result: execution.replayResult,
      retainedResult: undefined,
      userId,
    };
    const userCommandIds =
      this.#commandIds.get(userId) ?? new Map<string, LedgerEntry>();
    userCommandIds.set(command.commandId, created);
    this.#commandIds.set(userId, userCommandIds);
    const selectedUserEntries = userEntries ?? new Map<string, LedgerEntry>();
    selectedUserEntries.set(command.idempotencyKey, created);
    this.#entries.set(userId, selectedUserEntries);

    void execution.result.then((result) => {
      this.#complete(created, execution, result);
    });

    const result = await execution.result;
    return acknowledgement({ commandId: command.commandId, ...result });
  }

  #durableEntries(userId?: string): number {
    let count = 0;
    for (const [entryUserId] of this.#matchingEntries(({ operation }) =>
      commandRequiresDurableReceipt(operation),
    )) {
      if (userId === undefined || entryUserId === userId) {
        count += 1;
      }
    }
    return count;
  }

  #admission(
    userId: string,
    operation: string,
    payloadBytes: number,
  ): string | undefined {
    if (
      commandRequiresDurableReceipt(operation) &&
      (this.#durableEntries() >= this.#maximumEntries ||
        this.#durableEntries(userId) >= this.#maximumEntriesPerUser)
    ) {
      return RECEIPT_CAPACITY_EXCEEDED;
    }
    return this.#canStart(userId, operation, payloadBytes)
      ? undefined
      : "command_capacity_exceeded";
  }
}
