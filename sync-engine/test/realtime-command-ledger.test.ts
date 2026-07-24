import { expect, test, vi } from "vitest";
import type { UserRealtimeCommand } from "../../shared/user-realtime-protocol.ts";
import { RealtimeCommandLedger } from "../../sync-engine/realtime-command-ledger.ts";

const USER_ID = "user-1";

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
  const execute = vi.fn(() => Promise.resolve({ sessionId: "session-1" }));

  const first = await ledger.execute(USER_ID, command("command-1"), execute);
  const replay = await ledger.execute(USER_ID, command("command-2"), execute);

  expect(execute).toHaveBeenCalledOnce();
  expect(first).toEqual({
    commandId: "command-1",
    result: { sessionId: "session-1" },
    type: "command_success",
  });
  expect(replay).toEqual({
    commandId: "command-2",
    result: { sessionId: "session-1" },
    type: "command_success",
  });
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
  await ledger.execute(USER_ID, command("command-1", "first-key"), first);
  await ledger.execute(USER_ID, command("command-2", "second-key"), () =>
    Promise.resolve("second"),
  );
  await ledger.execute(USER_ID, command("command-3", "first-key"), first);
  expect(first).toHaveBeenCalledTimes(2);

  now = 20;
  await ledger.execute(USER_ID, command("command-4", "first-key"), first);
  expect(first).toHaveBeenCalledTimes(3);
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
  let resolve: ((value: string) => void) | undefined;
  const pending = ledger.execute(
    USER_ID,
    command("command-1", "pending-key"),
    () =>
      new Promise<string>((settle) => {
        resolve = settle;
      }),
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
  resolve?.("completed");
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
  expect(() => new RealtimeCommandLedger({ maximumEntries: 0 })).toThrow(
    RangeError,
  );
  expect(() => new RealtimeCommandLedger({ maximumPendingEntries: 0 })).toThrow(
    RangeError,
  );
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
