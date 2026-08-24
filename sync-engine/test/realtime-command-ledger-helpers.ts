import { expect, vi } from "vitest";
import { testDeferred } from "../../shared/test/promise-fixtures.ts";
import type { UserRealtimeCommand } from "../../shared/user-realtime-protocol.ts";
import {
  createRealtimeCommandLedger,
  type RealtimeCommandLedger,
  type RealtimeCommandLedgerOptions,
} from "../../sync-engine/realtime-command-ledger.ts";

export const USER_ID = "user-1";
export const WORKSPACE_ID = "workspace-1";
type Acknowledgement = Awaited<
  ReturnType<RealtimeCommandLedger["execute"]>
>["value"];
interface LedgerExecution {
  readonly action?: () => unknown;
  readonly acknowledgement: Acknowledgement;
  readonly command: UserRealtimeCommand;
  readonly userId?: string;
}

export type LedgerOptions = RealtimeCommandLedgerOptions;

export interface InvalidLedgerExecution extends LedgerExecution {
  readonly options?: LedgerOptions;
}

export function command(
  commandId: string,
  idempotencyKey = "mutation-1",
  operation = "sessions.send",
  payload: Readonly<Record<string, unknown>> = { prompt: "Do the work" },
): UserRealtimeCommand {
  return { commandId, idempotencyKey, operation, payload, type: "command" };
}

export const deferredValue = testDeferred;

export function resolved(value: unknown): () => Promise<unknown> {
  return () => Promise.resolve(value);
}

export function success(commandId: string, result: unknown): Acknowledgement {
  return { commandId, result, type: "command_success" };
}

export function failure(commandId: string, error: string): Acknowledgement {
  return { commandId, error, type: "command_error" };
}

export function execute(
  ledger: RealtimeCommandLedger,
  selectedCommand: UserRealtimeCommand,
  action: () => unknown,
  userId = USER_ID,
): Promise<Acknowledgement> {
  return ledger
    .execute(userId, WORKSPACE_ID, selectedCommand, action)
    .then(({ value }) => value);
}

export function constrainedRetentionLedger(): RealtimeCommandLedger {
  return createRealtimeCommandLedger({ maximumCompletedResultBytes: 5 });
}

export function receiptConstrainedLedger(
  maximumEntries = 2,
): RealtimeCommandLedger {
  return createRealtimeCommandLedger({
    maximumEntries,
    maximumEntriesPerUser: 1,
  });
}

async function expectReceiptCapacityRejection(
  ledger: RealtimeCommandLedger,
  rejected: () => Promise<unknown>,
): Promise<void> {
  await expectExecution(
    ledger,
    command("command-2", "second-key"),
    rejected,
    failure("command-2", "command_receipt_capacity_exceeded"),
  );
}

export async function receiptCapacityRejection(
  ledger: RealtimeCommandLedger,
): Promise<ReturnType<typeof vi.fn>> {
  const rejected = vi.fn(resolved("second"));
  await expectReceiptCapacityRejection(ledger, rejected);
  return rejected;
}

function pendingExecution(
  ledger: RealtimeCommandLedger,
  selectedCommand: UserRealtimeCommand,
  pending: Promise<string>,
): Promise<Acknowledgement> {
  return execute(ledger, selectedCommand, () => pending);
}

export function pendingLedger(): RealtimeCommandLedger {
  return createRealtimeCommandLedger({ maximumPendingEntries: 1 });
}

export function pendingValueWithExecution(
  ledger: RealtimeCommandLedger,
  selectedCommand: UserRealtimeCommand,
): {
  readonly execution: Promise<Acknowledgement>;
  readonly pending: ReturnType<typeof deferredValue<string>>;
} {
  const pending = deferredValue<string>();
  return {
    execution: pendingExecution(ledger, selectedCommand, pending.promise),
    pending,
  };
}

export function expectExecution(
  ledger: RealtimeCommandLedger,
  selectedCommand: UserRealtimeCommand,
  action: () => unknown,
  acknowledgement: Acknowledgement,
  userId = USER_ID,
): Promise<void> {
  return expect(
    execute(ledger, selectedCommand, action, userId),
  ).resolves.toEqual(acknowledgement);
}

export async function expectExecutions(
  ledger: RealtimeCommandLedger,
  executions: readonly LedgerExecution[],
  createLedger: (execution: LedgerExecution) => RealtimeCommandLedger = () =>
    ledger,
): Promise<void> {
  for (const execution of executions) {
    await expectExecution(
      createLedger(execution),
      execution.command,
      execution.action ?? unexpected,
      execution.acknowledgement,
      execution.userId,
    );
  }
}

export async function expectInvalidExecutions(
  executions: readonly InvalidLedgerExecution[],
): Promise<void> {
  for (const execution of executions) {
    await expectExecutions(createRealtimeCommandLedger(), [execution], () =>
      createRealtimeCommandLedger(execution.options),
    );
  }
}

async function expectLedgerOutcomes(
  ledger: RealtimeCommandLedger,
  outcomes: readonly (readonly [
    command: UserRealtimeCommand,
    expected: Acknowledgement,
    userId?: string,
  ])[],
): Promise<void> {
  for (const [selectedCommand, expected, userId] of outcomes) {
    await expectExecution(
      ledger,
      selectedCommand,
      unexpected,
      expected,
      userId,
    );
  }
}

export function expectUnknownOutcome(
  ledger: RealtimeCommandLedger,
  selectedCommand: UserRealtimeCommand,
): Promise<void> {
  return expectLedgerOutcomes(ledger, [
    [
      selectedCommand,
      failure(selectedCommand.commandId, "command_outcome_unknown"),
    ],
  ]);
}

export function expectReplayedSuccess(
  ledger: RealtimeCommandLedger,
  selectedCommand: UserRealtimeCommand,
  result: unknown,
  userId = USER_ID,
): Promise<void> {
  return expectLedgerOutcomes(ledger, [
    [selectedCommand, success(selectedCommand.commandId, result), userId],
  ]);
}

interface PendingRetryNeighbor {
  readonly action: () => Promise<unknown>;
  readonly userId: string;
}

interface PendingRetryExecutions {
  readonly first: Promise<Acknowledgement>;
  readonly neighbor?: Promise<Acknowledgement>;
  readonly retry: Promise<Acknowledgement>;
}

async function executePendingRetries(options: {
  readonly action: () => Promise<string>;
  readonly ledger: RealtimeCommandLedger;
  readonly neighbor?: PendingRetryNeighbor;
  readonly selectedCommand: UserRealtimeCommand;
}): Promise<PendingRetryExecutions> {
  const first = execute(
    options.ledger,
    options.selectedCommand,
    options.action,
  );
  const retry = execute(
    options.ledger,
    options.selectedCommand,
    options.action,
  );
  const neighbor =
    options.neighbor === undefined
      ? undefined
      : execute(
          options.ledger,
          options.selectedCommand,
          options.neighbor.action,
          options.neighbor.userId,
        );
  await Promise.resolve();
  return {
    first,
    ...(neighbor === undefined ? {} : { neighbor }),
    retry,
  };
}

export function expectPendingRetryResults(
  executions: PendingRetryExecutions,
  commandId: string,
  result: string,
  neighborResult?: string,
): Promise<unknown[]> {
  return Promise.all([
    expect(executions.first).resolves.toEqual(success(commandId, result)),
    expect(executions.retry).resolves.toEqual(success(commandId, result)),
    ...(neighborResult === undefined
      ? []
      : [
          expect(executions.neighbor).resolves.toEqual(
            success(commandId, neighborResult),
          ),
        ]),
  ]);
}

interface PendingRetrySetup {
  readonly action: ReturnType<typeof vi.fn<() => Promise<string>>>;
  readonly executions: PendingRetryExecutions;
  readonly pending: ReturnType<typeof deferredValue<string>>;
}

export async function pendingRetrySetup(
  ledger: RealtimeCommandLedger,
  selectedCommand: UserRealtimeCommand,
  neighbor?: PendingRetryNeighbor,
): Promise<PendingRetrySetup> {
  const pending = deferredValue<string>();
  const action = vi.fn(() => pending.promise);
  const executions = await executePendingRetries({
    action,
    ledger,
    ...(neighbor === undefined ? {} : { neighbor }),
    selectedCommand,
  });
  return { action, executions, pending };
}

export function unexpected(): Promise<unknown> {
  return Promise.resolve("unexpected");
}

interface ReadBatchNaming {
  readonly idempotencyPrefix: string;
  readonly includeOperation: boolean;
  readonly parallel: boolean;
  readonly prefix: string;
}

export async function expectReadBatch(
  ledger: RealtimeCommandLedger,
  operation: string,
  naming: ReadBatchNaming,
): Promise<void> {
  const executions = Array.from({ length: 20 }, (_, index): LedgerExecution => {
    const indexText = String(index);
    const suffix = naming.includeOperation ? `-${operation}` : "";
    const commandId = `${naming.prefix}-${indexText}${suffix}`;
    return {
      acknowledgement: success(commandId, index),
      action: resolved(index),
      command: command(
        commandId,
        `${naming.idempotencyPrefix}-${indexText}${suffix}`,
        operation,
        { index },
      ),
    };
  });
  if (naming.parallel) {
    await Promise.all(
      executions.map((execution) =>
        expectExecution(
          ledger,
          execution.command,
          execution.action ?? unexpected,
          execution.acknowledgement,
        ),
      ),
    );
    return;
  }
  await expectExecutions(ledger, executions);
}

export function sequentialCommands(): readonly [
  first: UserRealtimeCommand,
  second: UserRealtimeCommand,
] {
  return [
    command("command-1", "first-key"),
    command("command-2", "second-key"),
  ];
}

export async function expectRetentionOutcomes(
  ledger: RealtimeCommandLedger,
  unknownCommand: UserRealtimeCommand,
  retainedCommand: UserRealtimeCommand,
  retainedResult: unknown,
  retainedUserId?: string,
): Promise<void> {
  const retainedOutcome: readonly [
    command: UserRealtimeCommand,
    expected: Acknowledgement,
    userId?: string,
  ] =
    retainedUserId === undefined
      ? [retainedCommand, success(retainedCommand.commandId, retainedResult)]
      : [
          retainedCommand,
          success(retainedCommand.commandId, retainedResult),
          retainedUserId,
        ];
  await expectLedgerOutcomes(ledger, [
    [
      unknownCommand,
      failure(unknownCommand.commandId, "command_outcome_unknown"),
    ],
    retainedOutcome,
  ]);
}

export async function executeSequentially(
  ledger: RealtimeCommandLedger,
  selectedCommands = sequentialCommands(),
): Promise<void> {
  await execute(ledger, selectedCommands[0], resolved("first"));
  await execute(ledger, selectedCommands[1], resolved("second"));
}
