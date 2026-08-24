import { expect, test, vi } from "vitest";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import {
  createRealtimeCommandFailure,
  createRealtimeCommandLedger,
} from "../../sync-engine/realtime-command-ledger.ts";
import {
  command,
  constrainedRetentionLedger,
  deferredValue,
  execute,
  executeSequentially,
  expectExecution,
  expectExecutions,
  expectInvalidExecutions,
  expectPendingRetryResults,
  expectReadBatch,
  expectReplayedSuccess,
  expectRetentionOutcomes,
  expectUnknownOutcome,
  failure,
  pendingLedger,
  pendingRetrySetup,
  pendingValueWithExecution,
  receiptCapacityRejection,
  receiptConstrainedLedger,
  resolved,
  sequentialCommands,
  success,
  unexpected,
  USER_ID,
  WORKSPACE_ID,
  type InvalidLedgerExecution,
  type LedgerOptions,
} from "./realtime-command-ledger-helpers.ts";

test("executes once, snapshots the result, and replays the identical envelope", async () => {
  const ledger = createRealtimeCommandLedger();
  const value = { status: "created" };
  const action = vi.fn(() => value);
  const selectedCommand = command("command-1");

  const first = await execute(ledger, selectedCommand, action);
  value.status = "mutated";
  const replay = await execute(ledger, selectedCommand, action);

  expect(first).toEqual(success("command-1", { status: "created" }));
  expect(replay).toEqual(first);
  expect(action).toHaveBeenCalledOnce();
});

test("replays the literal serialized acknowledgement envelope", async () => {
  const ledger = createRealtimeCommandLedger();
  const selectedCommand = command("command-serialized");
  const first = await ledger.execute(
    USER_ID,
    WORKSPACE_ID,
    selectedCommand,
    resolved({ status: "created" }),
  );
  const replay = await ledger.execute(
    USER_ID,
    WORKSPACE_ID,
    selectedCommand,
    unexpected,
  );

  expect(replay.serialized).toBe(first.serialized);
  expect(replay.value).toEqual(first.value);
});

test("coalesces identical in-flight retries and isolates authenticated users", async () => {
  const ledger = createRealtimeCommandLedger();
  const selectedCommand = command("shared-command");
  const { action, executions, pending } = await pendingRetrySetup(
    ledger,
    selectedCommand,
    { action: resolved("neighbor"), userId: "user-2" },
  );
  pending.resolve("first");

  await expectPendingRetryResults(
    executions,
    "shared-command",
    "first",
    "neighbor",
  );
  expect(action).toHaveBeenCalledOnce();
});

test("completed reads cannot crowd mutation receipt capacity", async () => {
  const ledger = receiptConstrainedLedger(1);
  const readOperations = [
    SESSION_REALTIME_OPERATIONS.models,
    SESSION_REALTIME_OPERATIONS.read,
    SESSION_REALTIME_OPERATIONS.subscribe,
  ];
  for (const operation of readOperations) {
    await expectReadBatch(ledger, operation, {
      idempotencyPrefix: "key",
      includeOperation: true,
      parallel: false,
      prefix: "read",
    });
  }
  await expectReadBatch(ledger, SESSION_REALTIME_OPERATIONS.read, {
    idempotencyPrefix: "parallel-key",
    includeOperation: false,
    parallel: true,
    prefix: "parallel-read",
  });

  const mutation = command("mutation", "mutation-key");
  const mutate = vi.fn(resolved("mutated"));
  await expectExecution(
    ledger,
    mutation,
    mutate,
    success("mutation", "mutated"),
  );
  await expectReplayedSuccess(ledger, mutation, "mutated");

  const rejected = vi.fn(resolved("second mutation"));
  await expectExecution(
    ledger,
    command("mutation-2", "mutation-key-2"),
    rejected,
    failure("mutation-2", "command_receipt_capacity_exceeded"),
  );
  expect(mutate).toHaveBeenCalledOnce();
  expect(rejected).not.toHaveBeenCalled();
});

test("non-mutating retries coalesce in flight without using durable slots", async () => {
  const ledger = receiptConstrainedLedger(1);
  const mutation = command("mutation", "mutation-key");
  await execute(ledger, mutation, resolved("mutated"));

  const selectedCommand = command(
    "read-command",
    "read-key",
    SESSION_REALTIME_OPERATIONS.read,
  );
  const { action, executions, pending } = await pendingRetrySetup(
    ledger,
    selectedCommand,
  );
  expect(action).toHaveBeenCalledOnce();
  pending.resolve("detail");
  await expectPendingRetryResults(executions, "read-command", "detail");

  const completedRetry = vi.fn(resolved("fresh detail"));
  await expectExecution(
    ledger,
    selectedCommand,
    completedRetry,
    success("read-command", "fresh detail"),
  );
  await expectReplayedSuccess(ledger, mutation, "mutated");
  expect(completedRetry).toHaveBeenCalledOnce();
});

test("keeps an executed receipt after evicting its response body", async () => {
  const ledger = constrainedRetentionLedger();
  const selectedCommand = command("dropped-ack");
  const action = vi.fn(() => Promise.resolve("successful but too large"));

  await expectExecution(
    ledger,
    selectedCommand,
    action,
    success("dropped-ack", "successful but too large"),
  );
  await expectUnknownOutcome(ledger, selectedCommand);
  expect(action).toHaveBeenCalledOnce();
});

test("an in-flight replay resolves before its completed body is evicted", async () => {
  const ledger = constrainedRetentionLedger();
  const selectedCommand = command("same-tick");
  const action = vi.fn(resolved("successful but too large"));

  const first = execute(ledger, selectedCommand, action);
  const replay = execute(ledger, selectedCommand, action);
  const expected = success("same-tick", "successful but too large");

  await Promise.all([
    expect(first).resolves.toEqual(expected),
    expect(replay).resolves.toEqual(expected),
  ]);
  expect(action).toHaveBeenCalledOnce();
});

test("evicts bodies by deterministic global completion order", async () => {
  const ledger = createRealtimeCommandLedger({ maximumCompletedResults: 1 });
  const firstPending = deferredValue<string>();
  const [firstCommand, secondCommand] = sequentialCommands();

  const first = execute(ledger, firstCommand, () => firstPending.promise);
  await execute(ledger, secondCommand, resolved("second"));
  firstPending.resolve("first");
  await first;

  await expectRetentionOutcomes(ledger, secondCommand, firstCommand, "first");
});

test("completion sequence breaks equal-clock ties", async () => {
  const ledger = createRealtimeCommandLedger({
    maximumCompletedResults: 1,
    now: () => 7,
  });
  const [firstCommand, secondCommand] = sequentialCommands();
  await executeSequentially(ledger, [firstCommand, secondCommand]);
  await expectRetentionOutcomes(ledger, firstCommand, secondCommand, "second");
});

test("retention starts at completion rather than admission", async () => {
  let now = 1;
  const ledger = createRealtimeCommandLedger({
    now: () => now,
    retentionMs: 10,
  });
  const pending = deferredValue<string>();
  const selectedCommand = command("command-1");
  const first = execute(ledger, selectedCommand, () => pending.promise);

  now = 100;
  pending.resolve("completed");
  await expect(first).resolves.toEqual(success("command-1", "completed"));
  now = 109;
  await expectReplayedSuccess(ledger, selectedCommand, "completed");
  now = 110;
  await expectExecution(
    ledger,
    selectedCommand,
    resolved("reused"),
    success("command-1", "reused"),
  );
});

test("rejects receipt admission without evicting a completed receipt", async () => {
  const ledger = receiptConstrainedLedger();
  const firstCommand = command("command-1", "first-key");
  await execute(ledger, firstCommand, resolved("first"));
  const rejected = await receiptCapacityRejection(ledger);

  await expectExecution(
    ledger,
    command("command-3", "third-key"),
    resolved("neighbor"),
    success("command-3", "neighbor"),
    "user-2",
  );
  await expectReplayedSuccess(ledger, firstCommand, "first");
  expect(rejected).not.toHaveBeenCalled();
});

test("receipt limits do not evict mutation replay guarantees", async () => {
  const ledger = receiptConstrainedLedger();
  const pending = deferredValue<string>();
  const first = execute(
    ledger,
    command("command-1", "first-key"),
    () => pending.promise,
  );
  await Promise.resolve();
  const rejected = await receiptCapacityRejection(ledger);

  expect(rejected).not.toHaveBeenCalled();
  pending.resolve("first");
  await first;
});

test("rejected admission reserves nothing and an exact lost-ack retry can run", async () => {
  const ledger = pendingLedger();
  const admissionCommand = command("command-1", "first-key");
  const { execution: first, pending } = pendingValueWithExecution(
    ledger,
    admissionCommand,
  );
  const retriedCommand = command("command-2", "second-key");
  const retriedAction = vi.fn(resolved("retried"));
  await Promise.resolve();

  await expectExecution(
    ledger,
    retriedCommand,
    retriedAction,
    failure("command-2", "command_capacity_exceeded"),
  );
  pending.resolve("first");
  await first;
  await expectExecution(
    ledger,
    retriedCommand,
    retriedAction,
    success("command-2", "retried"),
  );
  expect(retriedAction).toHaveBeenCalledOnce();
});

test("partitions retained body count and byte budgets per user", async () => {
  const ledger = createRealtimeCommandLedger({
    maximumCompletedResultBytes: 100,
    maximumCompletedResultBytesPerUser: 10,
    maximumCompletedResults: 10,
    maximumCompletedResultsPerUser: 1,
  });
  const [firstCommand, secondCommand] = sequentialCommands();
  const neighborCommand = command("command-3", "third-key");
  await execute(ledger, firstCommand, resolved("first"));
  await execute(ledger, neighborCommand, resolved("neighbor"), "user-2");
  await execute(ledger, secondCommand, resolved("second"));
  await expectRetentionOutcomes(
    ledger,
    firstCommand,
    neighborCommand,
    "neighbor",
    "user-2",
  );
});

test("replays an idempotency key under a fresh command ID", async () => {
  const ledger = createRealtimeCommandLedger();
  const action = vi.fn(resolved("first"));
  await execute(ledger, command("command-1", "first-key"), action);

  await expectExecutions(ledger, [
    {
      acknowledgement: failure("command-1", "command_id_conflict"),
      action,
      command: command("command-1", "second-key"),
    },
    {
      acknowledgement: success("command-2", "first"),
      action,
      command: command("command-2", "first-key"),
    },
  ]);
  expect(action).toHaveBeenCalledOnce();
});

test("coalesces an in-flight idempotency key under a fresh command ID", async () => {
  const ledger = createRealtimeCommandLedger();
  const { promise, resolve } = Promise.withResolvers<string>();
  const action = vi.fn(() => promise);
  const first = execute(ledger, command("command-1", "first-key"), action);
  const retry = execute(ledger, command("command-2", "first-key"), action);

  resolve("first");
  await Promise.all([
    expect(first).resolves.toEqual(success("command-1", "first")),
    expect(retry).resolves.toEqual(success("command-2", "first")),
  ]);
  expect(action).toHaveBeenCalledOnce();
});

test("replays a failed idempotency key under a fresh command ID", async () => {
  const action = vi.fn(() => {
    throw createRealtimeCommandFailure("session_busy");
  });
  const ledger = createRealtimeCommandLedger();

  await expectExecution(
    ledger,
    command("command-1", "first-key"),
    action,
    failure("command-1", "session_busy"),
  );
  await expectExecution(
    ledger,
    command("command-2", "first-key"),
    action,
    failure("command-2", "session_busy"),
  );
  expect(action).toHaveBeenCalledOnce();
});

test("rejects a changed fingerprint without retaining mutable payload objects", async () => {
  const ledger = createRealtimeCommandLedger();
  const payload: Record<string, string> = { prompt: "original" };
  const selectedCommand = command(
    "command-1",
    "mutation-1",
    "sessions.send",
    payload,
  );
  const action = vi.fn(resolved("done"));
  await execute(ledger, selectedCommand, action);
  payload["prompt"] = "changed";

  await expectExecution(
    ledger,
    selectedCommand,
    action,
    failure("command-1", "idempotency_conflict"),
  );
  expect(action).toHaveBeenCalledOnce();
});

test("bounds pending entries, payload bytes, and operations per user", async () => {
  const ledger = createRealtimeCommandLedger({
    maximumPendingBytesPerUser: 10,
    maximumPendingEntries: 3,
    maximumPendingEntriesPerOperation: { "sessions.send": 1 },
    maximumPendingEntriesPerUser: 2,
    payloadBytes: (selectedCommand) => Number(selectedCommand.payload["bytes"]),
  });
  const { execution: first, pending } = pendingValueWithExecution(
    ledger,
    command("command-1", "first-key", "sessions.send", { bytes: 8 }),
  );
  await Promise.resolve();

  await expectExecutions(ledger, [
    {
      acknowledgement: failure("command-2", "command_capacity_exceeded"),
      command: command("command-2", "second-key", "sessions.send", {
        bytes: 3,
      }),
    },
    {
      acknowledgement: success("command-3", "neighbor"),
      action: resolved("neighbor"),
      command: command("command-3", "third-key", "sessions.stop", {
        bytes: 10,
      }),
      userId: "user-2",
    },
  ]);
  pending.resolve("first");
  await first;
});

test("turns oversized, unserializable, and unexpected results into safe receipts", async () => {
  const oversizedLedger = createRealtimeCommandLedger({
    maximumResultBytes: 5,
  });
  await expectExecutions(oversizedLedger, [
    {
      acknowledgement: failure("oversized", "command_result_too_large"),
      action: resolved("too-large"),
      command: command("oversized"),
    },
    {
      acknowledgement: failure("oversized", "command_result_too_large"),
      command: command("oversized"),
    },
  ]);

  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  await expectExecutions(createRealtimeCommandLedger(), [
    {
      acknowledgement: failure("circular", "command_failed"),
      action: () => circular,
      command: command("circular"),
    },
    {
      acknowledgement: failure("throwing", "command_failed"),
      action: () => {
        throw new Error("private detail");
      },
      command: command("throwing", "throwing-key"),
    },
  ]);
});

test("retains valid explicit command failures and sanitizes invalid codes", async () => {
  const ledger = createRealtimeCommandLedger();
  await expectExecutions(ledger, [
    {
      acknowledgement: failure("command-1", "session_busy"),
      action: () => {
        throw createRealtimeCommandFailure("session_busy");
      },
      command: command("command-1"),
    },
    {
      acknowledgement: failure("command-2", "command_failed"),
      action: () => {
        throw createRealtimeCommandFailure("contains private spaces");
      },
      command: command("command-2", "second-key"),
    },
  ]);
});

test("preserves explicit command error detail for the browser", async () => {
  const ledger = createRealtimeCommandLedger();
  await expectExecution(
    ledger,
    command("invalid-cap"),
    () => {
      throw createRealtimeCommandFailure(
        "invalid_context_token_cap",
        "Context token cap cannot exceed the model limit of 64,000 tokens.",
      );
    },
    {
      commandId: "invalid-cap",
      detail:
        "Context token cap cannot exceed the model limit of 64,000 tokens.",
      error: "invalid_context_token_cap",
      type: "command_error",
    },
  );
});

test("rejects invalid accounting, clocks, identities, and constructor limits", async () => {
  const action = vi.fn(unexpected);
  const invalidExecutions: readonly InvalidLedgerExecution[] = [
    {
      acknowledgement: failure("bad", "command_capacity_exceeded"),
      action,
      command: command("bad"),
      options: { payloadBytes: () => Number.NaN },
    },
    {
      acknowledgement: failure("clock", "command_capacity_exceeded"),
      action,
      command: command("clock"),
      options: { now: () => Number.NaN },
    },
    {
      acknowledgement: failure("identity", "command_capacity_exceeded"),
      action,
      command: command("identity"),
      userId: "",
    },
  ];
  await expectInvalidExecutions(invalidExecutions);
  expect(action).not.toHaveBeenCalled();

  const invalidOptions: readonly LedgerOptions[] = [
    { maximumCompletedResultBytes: 0 },
    { maximumCompletedResultBytesPerUser: 0 },
    { maximumCompletedResults: 0 },
    { maximumCompletedResultsPerUser: 0 },
    { maximumEntries: 0 },
    { maximumEntriesPerUser: 0 },
    { maximumPendingBytesPerUser: 0 },
    { maximumPendingEntries: 0 },
    { maximumPendingEntriesPerOperation: { invalid: 1 } },
    { maximumPendingEntriesPerUser: 0 },
    { maximumResultBytes: 0 },
    { retentionMs: 0 },
  ];
  for (const options of invalidOptions) {
    expect(() => createRealtimeCommandLedger(options)).toThrow(RangeError);
  }
});
