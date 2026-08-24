import type { UserRealtimeCommand } from "../shared/user-realtime-protocol.ts";
import {
  commandExecution,
  commandRequiresDurableReceipt,
  resultBodyBytes,
  type CommandExecution,
  type CommandResult,
} from "./realtime-command-execution.ts";
import {
  commandFingerprint,
  commandPayloadBytes,
  scopedCommandIdentity,
} from "./realtime-command-identity.ts";

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

type RealtimeCommandErrorAcknowledgement = Readonly<{
  commandId: string;
  detail?: string;
  error: string;
  type: "command_error";
}>;

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
  readonly workspaceId: string;
}

interface CompletedUserUsage {
  bytes: number;
  results: number;
}

export interface RealtimeCommandLedgerOptions {
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

function positiveLimit(limit: number | undefined): boolean {
  return limit === undefined || (Number.isSafeInteger(limit) && limit >= 1);
}

type RealtimeCommandExecute = (
  userId: string,
  workspaceId: string,
  command: UserRealtimeCommand,
  execute: () => unknown,
) => Promise<SerializedRealtimeAcknowledgement>;

export interface RealtimeCommandLedger {
  readonly execute: RealtimeCommandExecute;
}

export function createRealtimeCommandLedger(
  options: RealtimeCommandLedgerOptions = {},
): RealtimeCommandLedger {
  const ledgerCommandIds = new Map<string, Map<string, LedgerEntry>>();
  let ledgerCompletedResultBytes = 0;
  const ledgerCompletedUsers = new Map<string, CompletedUserUsage>();
  const ledgerEntries = new Map<string, Map<string, LedgerEntry>>();
  let ledgerNextCompletionOrder = 0n;
  let ledgerPendingEntries = 0;
  const ledgerPendingUsers = new Map<
    string,
    { bytes: number; entries: number; operations: Map<string, number> }
  >();
  const ledgerMaximumCompletedResultBytes =
    options.maximumCompletedResultBytes ??
    DEFAULT_MAXIMUM_COMPLETED_RESULT_BYTES;
  const ledgerMaximumCompletedResultBytesPerUser =
    options.maximumCompletedResultBytesPerUser ??
    DEFAULT_MAXIMUM_COMPLETED_RESULT_BYTES_PER_USER;
  const ledgerMaximumCompletedResults =
    options.maximumCompletedResults ?? DEFAULT_MAXIMUM_COMPLETED_RESULTS;
  const ledgerMaximumCompletedResultsPerUser =
    options.maximumCompletedResultsPerUser ??
    DEFAULT_MAXIMUM_COMPLETED_RESULTS_PER_USER;
  const ledgerMaximumEntries =
    options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
  const ledgerMaximumEntriesPerUser =
    options.maximumEntriesPerUser ?? DEFAULT_MAXIMUM_ENTRIES_PER_USER;
  const ledgerMaximumPendingBytesPerUser =
    options.maximumPendingBytesPerUser ??
    DEFAULT_MAXIMUM_PENDING_BYTES_PER_USER;
  const ledgerMaximumPendingEntries =
    options.maximumPendingEntries ?? DEFAULT_MAXIMUM_PENDING_ENTRIES;
  const ledgerMaximumPendingEntriesPerOperation =
    options.maximumPendingEntriesPerOperation === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(options.maximumPendingEntriesPerOperation),
        );
  const ledgerMaximumPendingEntriesPerUser =
    options.maximumPendingEntriesPerUser ??
    DEFAULT_MAXIMUM_PENDING_ENTRIES_PER_USER;
  const ledgerMaximumResultBytes =
    options.maximumResultBytes ?? MAXIMUM_COMMAND_RESULT_LENGTH;
  const ledgerNow = options.now ?? Date.now;
  const ledgerPayloadBytes = options.payloadBytes ?? commandPayloadBytes;
  const ledgerRetentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000;

  const operationLimits = Object.entries(
    ledgerMaximumPendingEntriesPerOperation ?? {},
  );
  if (
    !positiveLimit(ledgerMaximumCompletedResultBytes) ||
    !positiveLimit(ledgerMaximumCompletedResultBytesPerUser) ||
    !positiveLimit(ledgerMaximumCompletedResults) ||
    !positiveLimit(ledgerMaximumCompletedResultsPerUser) ||
    !positiveLimit(ledgerMaximumEntries) ||
    !positiveLimit(ledgerMaximumEntriesPerUser) ||
    !positiveLimit(ledgerMaximumPendingBytesPerUser) ||
    !positiveLimit(ledgerMaximumPendingEntries) ||
    !positiveLimit(ledgerMaximumPendingEntriesPerUser) ||
    !positiveLimit(ledgerMaximumResultBytes) ||
    !positiveLimit(ledgerRetentionMs) ||
    typeof ledgerNow !== "function" ||
    typeof ledgerPayloadBytes !== "function" ||
    !operationLimits.every(
      ([operation, limit]) =>
        /^[a-z][a-z\d_]*(?:\.[a-z][a-z\d_]*){1,7}$/u.test(operation) &&
        positiveLimit(limit),
    )
  ) {
    throw new RangeError("Realtime command ledger limits must be positive");
  }
  function deleteEntry(
    userId: string,
    idempotencyKey: string,
    entry: LedgerEntry,
  ): void {
    const userCommandIds = ledgerCommandIds.get(userId);
    const userEntries = ledgerEntries.get(userId);
    if (
      userCommandIds?.get(
        scopedCommandIdentity(entry.workspaceId, entry.commandId),
      ) !== entry ||
      userEntries?.get(idempotencyKey) !== entry
    ) {
      return;
    }
    userCommandIds.delete(
      scopedCommandIdentity(entry.workspaceId, entry.commandId),
    );
    userEntries.delete(idempotencyKey);
    removeRetainedResult(entry);
    if (userCommandIds.size === 0) {
      ledgerCommandIds.delete(userId);
    }
    if (userEntries.size === 0) {
      ledgerEntries.delete(userId);
    }
  }

  function removeRetainedResult(entry: LedgerEntry): void {
    const completionOrder = entry.completionOrder;
    if (completionOrder === undefined || entry.retainedResult === undefined) {
      return;
    }
    ledgerCompletedResultBytes -= entry.completedBytes;
    const user = ledgerCompletedUsers.get(entry.userId);
    if (user !== undefined) {
      user.bytes -= entry.completedBytes;
      user.results -= 1;
      if (user.results === 0) {
        ledgerCompletedUsers.delete(entry.userId);
      }
    }
    entry.completedBytes = 0;
    entry.completedAcknowledgement = undefined;
    entry.completionOrder = undefined;
    entry.retainedResult = undefined;
  }

  function* matchingEntries(
    matches: (entry: LedgerEntry) => boolean,
  ): IterableIterator<
    readonly [userId: string, idempotencyKey: string, entry: LedgerEntry]
  > {
    for (const [userId, entries] of ledgerEntries) {
      for (const [idempotencyKey, entry] of entries) {
        if (matches(entry)) {
          yield [userId, idempotencyKey, entry];
        }
      }
    }
  }

  function pruneExpired(now: number): void {
    const expired = new Array<
      readonly [userId: string, idempotencyKey: string, entry: LedgerEntry]
    >();
    for (const entry of matchingEntries(({ expiresAt }) => expiresAt <= now)) {
      expired.push(entry);
    }
    for (const entry of expired) {
      deleteEntry(...entry);
    }
  }

  function oldestRetainedResult(userId?: string): LedgerEntry | undefined {
    let oldest: LedgerEntry | undefined;
    for (const [, , entry] of matchingEntries(
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

  function evictResultBodies(userId: string): void {
    let user = ledgerCompletedUsers.get(userId);
    while (
      user !== undefined &&
      (user.bytes > ledgerMaximumCompletedResultBytesPerUser ||
        user.results > ledgerMaximumCompletedResultsPerUser)
    ) {
      const oldest = oldestRetainedResult(userId);
      if (oldest === undefined) {
        break;
      }
      removeRetainedResult(oldest);
      user = ledgerCompletedUsers.get(userId);
    }

    let oldest = oldestRetainedResult();
    while (oldest !== undefined) {
      let retainedResults = 0;
      const results = matchingEntries(
        ({ retainedResult }) => retainedResult !== undefined,
      );
      while (!results.next().done) {
        retainedResults += 1;
      }
      if (
        ledgerCompletedResultBytes <= ledgerMaximumCompletedResultBytes &&
        retainedResults <= ledgerMaximumCompletedResults
      ) {
        break;
      }
      removeRetainedResult(oldest);
      oldest = oldestRetainedResult();
    }
  }

  function canStart(
    userId: string,
    operation: string,
    payloadBytes: number,
  ): boolean {
    const user = ledgerPendingUsers.get(userId);
    const operationLimit = ledgerMaximumPendingEntriesPerOperation?.[operation];
    return (
      ledgerPendingEntries < ledgerMaximumPendingEntries &&
      (user?.entries ?? 0) < ledgerMaximumPendingEntriesPerUser &&
      Number.isSafeInteger(payloadBytes) &&
      payloadBytes >= 0 &&
      payloadBytes <= ledgerMaximumPendingBytesPerUser - (user?.bytes ?? 0) &&
      (operationLimit === undefined ||
        (user?.operations.get(operation) ?? 0) < operationLimit)
    );
  }

  function addPending(
    userId: string,
    operation: string,
    payloadBytes: number,
  ): void {
    const user = ledgerPendingUsers.get(userId) ?? {
      bytes: 0,
      entries: 0,
      operations: new Map<string, number>(),
    };
    user.bytes += payloadBytes;
    user.entries += 1;
    user.operations.set(operation, (user.operations.get(operation) ?? 0) + 1);
    ledgerPendingUsers.set(userId, user);
    ledgerPendingEntries += 1;
  }

  function removePending(...pending: readonly [string, string, number]): void {
    const [userId, operation, payloadBytes] = pending;
    const user = ledgerPendingUsers.get(userId);
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
      ledgerPendingUsers.delete(userId);
    }
    ledgerPendingEntries -= 1;
  }

  function completionExpiry(): number {
    const completedAt = nowValue();
    if (completedAt === undefined || !Number.isSafeInteger(completedAt)) {
      return Number.POSITIVE_INFINITY;
    }
    const expiresAt = completedAt + ledgerRetentionMs;
    return Number.isSafeInteger(expiresAt)
      ? expiresAt
      : Number.POSITIVE_INFINITY;
  }

  function retainResult(entry: LedgerEntry, result: CommandResult): void {
    const bytes = resultBodyBytes(result);
    ledgerNextCompletionOrder += 1n;
    entry.completedBytes = bytes;
    entry.completionOrder = ledgerNextCompletionOrder;
    entry.retainedResult = result;
    ledgerCompletedResultBytes += bytes;
    const user = ledgerCompletedUsers.get(entry.userId) ?? {
      bytes: 0,
      results: 0,
    };
    user.bytes += bytes;
    user.results += 1;
    ledgerCompletedUsers.set(entry.userId, user);
    evictResultBodies(entry.userId);
  }

  function complete(
    entry: LedgerEntry,
    execution: CommandExecution,
    result: CommandResult,
  ): void {
    try {
      entry.completedAcknowledgement = acknowledgement({
        commandId: entry.commandId,
        ...result,
      });
      removePending(entry.userId, entry.operation, entry.pendingBytes);
      if (commandRequiresDurableReceipt(entry.operation)) {
        entry.expiresAt = completionExpiry();
        retainResult(entry, result);
      } else {
        // Later retries execute a fresh read and cannot consume mutation slots.
        deleteEntry(
          entry.userId,
          scopedCommandIdentity(entry.workspaceId, entry.idempotencyKey),
          entry,
        );
      }
    } finally {
      execution.resolveCompletion();
    }
  }

  function error(
    commandId: string,
    error: string,
  ): SerializedRealtimeAcknowledgement {
    return acknowledgement({ commandId, error, type: "command_error" });
  }

  function replay(
    command: UserRealtimeCommand,
    commandDigest: string | undefined,
    entry: LedgerEntry,
  ):
    | SerializedRealtimeAcknowledgement
    | Promise<SerializedRealtimeAcknowledgement> {
    if (commandDigest === undefined || entry.commandDigest !== commandDigest) {
      return error(command.commandId, "idempotency_conflict");
    }
    const receipt = entry.completedAcknowledgement;
    if (receipt !== undefined) {
      return command.commandId === entry.commandId
        ? receipt
        : acknowledgement({ ...receipt.value, commandId: command.commandId });
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

  function nowValue(): number | undefined {
    try {
      return ledgerNow();
    } catch {
      return undefined;
    }
  }

  const execute: RealtimeCommandExecute = async (...parameters) => {
    const [userId, workspaceId, command, executeCommand] = parameters;
    const admittedAt = nowValue();
    if (
      admittedAt === undefined ||
      !Number.isSafeInteger(admittedAt) ||
      userId.length === 0 ||
      workspaceId.length === 0
    ) {
      return error(command.commandId, "command_capacity_exceeded");
    }
    pruneExpired(admittedAt);
    const userEntries = ledgerEntries.get(userId);
    // Retained outcomes are local to the authenticated connection workspace.
    // Reusing either identifier in another workspace starts a fresh command.
    const idempotencyIdentity = scopedCommandIdentity(
      workspaceId,
      command.idempotencyKey,
    );
    const commandIdentity = scopedCommandIdentity(
      workspaceId,
      command.commandId,
    );
    const existing = userEntries?.get(idempotencyIdentity);
    const commandDigest = commandFingerprint(command);
    const commandIdEntry = ledgerCommandIds.get(userId)?.get(commandIdentity);
    if (commandIdEntry !== undefined) {
      if (commandIdEntry !== existing) {
        return error(command.commandId, "command_id_conflict");
      }
      return replay(command, commandDigest, commandIdEntry);
    }
    if (existing !== undefined) {
      return replay(command, commandDigest, existing);
    }

    let payloadBytes: number | undefined;
    try {
      payloadBytes = ledgerPayloadBytes(command);
    } catch {
      payloadBytes = undefined;
    }
    if (commandDigest === undefined) {
      return error(command.commandId, "invalid_command");
    }
    if (payloadBytes === undefined || !Number.isSafeInteger(payloadBytes)) {
      return error(command.commandId, "command_capacity_exceeded");
    }
    const admissionResult = admission(userId, command.operation, payloadBytes);
    if (admissionResult !== undefined) {
      // No mutation ran, so a lost rejection may be retried with the exact
      // envelope and admitted later; the rejection reserves nothing.
      return error(command.commandId, admissionResult);
    }

    addPending(userId, command.operation, payloadBytes);
    let execution: CommandExecution;
    try {
      execution = commandExecution(executeCommand, ledgerMaximumResultBytes);
    } catch {
      removePending(userId, command.operation, payloadBytes);
      return error(command.commandId, "command_failed");
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
      workspaceId,
    };
    const userCommandIds =
      ledgerCommandIds.get(userId) ?? new Map<string, LedgerEntry>();
    userCommandIds.set(commandIdentity, created);
    ledgerCommandIds.set(userId, userCommandIds);
    const selectedUserEntries = userEntries ?? new Map<string, LedgerEntry>();
    selectedUserEntries.set(idempotencyIdentity, created);
    ledgerEntries.set(userId, selectedUserEntries);

    void execution.result.then((result) => {
      complete(created, execution, result);
    });

    const result = await execution.result;
    return acknowledgement({ commandId: command.commandId, ...result });
  };

  function durableEntries(userId?: string): number {
    let count = 0;
    for (const [entryUserId] of matchingEntries(({ operation }) =>
      commandRequiresDurableReceipt(operation),
    )) {
      if (userId === undefined || entryUserId === userId) {
        count += 1;
      }
    }
    return count;
  }

  function admission(
    userId: string,
    operation: string,
    payloadBytes: number,
  ): string | undefined {
    if (
      commandRequiresDurableReceipt(operation) &&
      (durableEntries() >= ledgerMaximumEntries ||
        durableEntries(userId) >= ledgerMaximumEntriesPerUser)
    ) {
      return RECEIPT_CAPACITY_EXCEEDED;
    }
    return canStart(userId, operation, payloadBytes)
      ? undefined
      : "command_capacity_exceeded";
  }

  return { execute };
}
