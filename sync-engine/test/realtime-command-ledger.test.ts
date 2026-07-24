import { expect, test, vi } from "vitest";
import type { UserRealtimeCommand } from "../../shared/user-realtime-protocol.ts";
import { RealtimeCommandLedger } from "../../sync-engine/realtime-command-ledger.ts";

const USER_ID = "user-1";

async function executeCommand(
  ledger: RealtimeCommandLedger,
  commandId: string,
  idempotencyKey: string,
  execute: () => unknown,
): Promise<unknown> {
  return ledger.execute(USER_ID, command(commandId, idempotencyKey), execute);
}

async function exerciseEviction(
  ledger: RealtimeCommandLedger,
  first: () => unknown,
  secondValue: string,
): Promise<void> {
  const executions = [
    ["command-1", "first-key", first],
    ["command-2", "second-key", resolved(secondValue)],
    ["command-3", "first-key", first],
  ] as const;
  for (const [commandId, idempotencyKey, execute] of executions) {
    await executeCommand(ledger, commandId, idempotencyKey, execute);
  }
}

function expectReplayError(results: readonly unknown[], error: string): void {
  expect(results).toMatchObject([{ error }, { error }]);
}

function expectResultPair(results: readonly unknown[]): void {
  expect(results).toMatchObject([{ result: "first" }, { result: "second" }]);
}

function resolved(value: unknown): () => Promise<unknown> {
  return () => Promise.resolve(value);
}

function concurrentExecutions(
  requests: readonly [
    ledger: RealtimeCommandLedger,
    userId: string,
    command: UserRealtimeCommand,
    execute: () => unknown,
  ][],
): Promise<readonly unknown[]> {
  return Promise.all(
    requests.map(([ledger, userId, selectedCommand, execute]) =>
      ledger.execute(userId, selectedCommand, execute),
    ),
  );
}

function circularValue(): Readonly<Record<string, unknown>> {
  const value: { self?: unknown } = {};
  value.self = value;
  return value;
}

function runTwice(
  ledger: RealtimeCommandLedger,
  execute: () => unknown,
): Promise<
  readonly [
    Awaited<ReturnType<RealtimeCommandLedger["execute"]>>,
    Awaited<ReturnType<RealtimeCommandLedger["execute"]>>,
  ]
> {
  return Promise.all([
    ledger.execute(USER_ID, command("command-1"), execute),
    ledger.execute(USER_ID, command("command-2"), execute),
  ]);
}

function successAcknowledgement(
  commandId: string,
  result: unknown,
): Readonly<Record<string, unknown>> {
  return { commandId, result, type: "command_success" };
}

function deferredValue<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let settle: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value) => settle?.(value),
  };
}

function deferredString(): ReturnType<typeof deferredValue<string>> {
  return deferredValue<string>();
}

function command(
  commandId: string,
  idempotencyKey = "mutation-1",
): UserRealtimeCommand {
  return {
    commandId,
    idempotencyKey,
    operation: "sessions.send",
    payload: { prompt: "Do the work" },
    type: "command",
  };
}

test("executes an idempotent command exactly once and replays its result", async () => {
  const ledger = new RealtimeCommandLedger();
  const execute = vi.fn(resolved({ sessionId: "session-1" }));

  const [first, replay] = await runTwice(ledger, execute);

  expect(execute).toHaveBeenCalledOnce();
  expect(first).toEqual(
    successAcknowledgement("command-1", { sessionId: "session-1" }),
  );
  expect(replay).toEqual(
    successAcknowledgement("command-2", { sessionId: "session-1" }),
  );
});

test("coalesces concurrent retries and scopes keys to the authenticated user", async () => {
  const ledger = new RealtimeCommandLedger();
  let resolve: ((value: unknown) => void) | undefined;
  const execute = vi.fn(
    () =>
      new Promise((settle) => {
        resolve = settle;
      }),
  );
  const first = ledger.execute(USER_ID, command("command-1"), execute);
  const retry = ledger.execute(USER_ID, command("command-2"), execute);
  const other = ledger.execute("user-2", command("command-3"), () =>
    Promise.resolve({ other: true }),
  );
  await Promise.resolve();
  resolve?.({ sessionId: "session-1" });

  expect((await first).type).toBe("command_success");
  expect((await retry).commandId).toBe("command-2");
  expect((await other).type).toBe("command_success");
  expect(execute).toHaveBeenCalledOnce();
});

test("bounds and expires completed idempotency results", async () => {
  let now = 1;
  const ledger = new RealtimeCommandLedger({
    maximumEntries: 1,
    now: () => now,
    retentionMs: 10,
  });
  const first = vi.fn(() => Promise.resolve("first"));
  await exerciseEviction(ledger, first, "second");
  expect(first).toHaveBeenCalledTimes(2);

  now = 20;
  await executeCommand(ledger, "command-4", "first-key", first);
  expect(first).toHaveBeenCalledTimes(3);
});

test("evicts completed results when their aggregate byte budget is exceeded", async () => {
  const ledger = new RealtimeCommandLedger({
    maximumCompletedResultBytes: 12,
  });
  const first = vi.fn(resolved("123456"));

  await exerciseEviction(ledger, first, "abcdef");

  expect(first).toHaveBeenCalledTimes(2);
});

test("does not double-count a large result evicted during completion", async () => {
  const ledger = new RealtimeCommandLedger({
    maximumCompletedResultBytes: 5,
    maximumEntries: 2,
  });
  const large = vi.fn(resolved("large-result"));
  await executeCommand(ledger, "command-large", "large-key", large);
  await Promise.resolve();

  await executeCommand(ledger, "command-small", "small-key", resolved("x"));
  await executeCommand(ledger, "command-retry", "large-key", large);

  expect(large).toHaveBeenCalledTimes(2);
});

test("replays a completed entry even while the ledger is at capacity", async () => {
  const ledger = new RealtimeCommandLedger({ maximumEntries: 1 });
  const execute = vi.fn(() => Promise.resolve("completed"));
  await ledger.execute(USER_ID, command("command-1", "first-key"), execute);

  const replay = await ledger.execute(
    USER_ID,
    command("command-2", "first-key"),
    execute,
  );

  expect(replay).toMatchObject({ result: "completed" });
  expect(execute).toHaveBeenCalledOnce();
});

test("keeps in-flight commands until completion and bounds concurrent entries", async () => {
  const ledger = new RealtimeCommandLedger({ maximumPendingEntries: 1 });
  const pendingExecution = deferredString();
  const pending = ledger.execute(
    USER_ID,
    command("command-1", "pending-key"),
    () => pendingExecution.promise,
  );
  await Promise.resolve();

  const rejected = await ledger.execute(
    USER_ID,
    command("command-2", "other-key"),
    () => Promise.resolve("unexpected"),
  );
  const replay = ledger.execute(
    USER_ID,
    command("command-3", "pending-key"),
    () => Promise.resolve("unexpected"),
  );

  expect(rejected).toEqual({
    commandId: "command-2",
    error: "command_capacity_exceeded",
    type: "command_error",
  });
  pendingExecution.resolve("completed");
  await expect(pending).resolves.toMatchObject({ result: "completed" });
  await expect(replay).resolves.toMatchObject({
    commandId: "command-3",
    result: "completed",
  });

  await expect(
    ledger.execute(USER_ID, command("command-4", "other-key"), () =>
      Promise.resolve("accepted"),
    ),
  ).resolves.toMatchObject({ result: "accepted" });
});

test("requires positive command capacity", () => {
  for (const options of [
    { maximumCompletedResultBytes: 0 },
    { maximumEntries: 0 },
    { maximumPendingEntries: 0 },
    { maximumResultBytes: 0 },
  ]) {
    expect(() => new RealtimeCommandLedger(options)).toThrow(RangeError);
  }
});

test("turns oversized command results into replayable safe errors", async () => {
  const ledger = new RealtimeCommandLedger({ maximumResultBytes: 5 });
  const execute = vi.fn(resolved("oversized"));

  const results = await runTwice(ledger, execute);

  expectReplayError(results, "command_result_too_large");
  expect(execute).toHaveBeenCalledOnce();
});

test("turns circular command results into replayable safe errors", async () => {
  const ledger = new RealtimeCommandLedger();
  const circular = circularValue();
  const execute = vi.fn(() => circular);

  const results = await runTwice(ledger, execute);

  expectReplayError(results, "command_failed");
  expect(results).toMatchObject([
    { commandId: "command-1", type: "command_error" },
    { commandId: "command-2", type: "command_error" },
  ]);
  expect(execute).toHaveBeenCalledOnce();
});

test("rejects duplicate command IDs with different idempotency keys while pending", async () => {
  const ledger = new RealtimeCommandLedger();
  const firstExecution = deferredString();
  const conflictingExecution = vi.fn(() => Promise.resolve("unexpected"));
  const first = ledger.execute(
    USER_ID,
    command("command-collision", "first-key"),
    () => firstExecution.promise,
  );
  await Promise.resolve();

  const conflict = await ledger.execute(
    USER_ID,
    command("command-collision", "second-key"),
    conflictingExecution,
  );

  expect(conflict).toEqual({
    commandId: "command-collision",
    error: "command_id_conflict",
    type: "command_error",
  });
  expect(conflictingExecution).not.toHaveBeenCalled();
  firstExecution.resolve("completed");
  await expect(first).resolves.toMatchObject({ result: "completed" });
});

test("allows different users to use the same command ID", async () => {
  const ledger = new RealtimeCommandLedger();

  const results = await concurrentExecutions([
    [
      ledger,
      USER_ID,
      command("shared-command", "first-key"),
      resolved("first"),
    ],
    [
      ledger,
      "user-2",
      command("shared-command", "second-key"),
      resolved("second"),
    ],
  ]);
  expectResultPair(results);
});

test("does not let delimiter-containing user IDs collide", async () => {
  const ledger = new RealtimeCommandLedger();
  const first = vi.fn(resolved("first"));
  const second = vi.fn(resolved("second"));

  const results = await concurrentExecutions([
    [ledger, "user:a", command("command-1", "b"), first],
    [ledger, "user", command("command-2", "a:b"), second],
  ]);
  expectResultPair(results);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
});

test("allows a command ID to be reused after its ledger entry is evicted", async () => {
  const ledger = new RealtimeCommandLedger({ maximumEntries: 1 });

  await ledger.execute(
    USER_ID,
    command("reused-command", "first-key"),
    resolved("first"),
  );
  await ledger.execute(
    USER_ID,
    command("other-command", "other-key"),
    resolved("other"),
  );

  await expect(
    ledger.execute(
      USER_ID,
      command("reused-command", "second-key"),
      resolved("second"),
    ),
  ).resolves.toMatchObject({ result: "second" });
});

test("rejects reuse of an idempotency key for a different command", async () => {
  const ledger = new RealtimeCommandLedger();
  await ledger.execute(USER_ID, command("command-1"), () =>
    Promise.resolve({ ok: true }),
  );

  const result = await ledger.execute(
    USER_ID,
    {
      ...command("command-2"),
      operation: "sessions.stop",
      payload: { sessionId: "session-1" },
    },
    () => Promise.resolve({ ok: false }),
  );

  expect(result).toEqual({
    commandId: "command-2",
    error: "idempotency_conflict",
    type: "command_error",
  });
});
