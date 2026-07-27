import { afterEach, expect, test, vi } from "vitest";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import {
  commandRealtimeTestSetup,
  finishRealtimeTestReconnect,
  openRealtimeTestConnection,
  reconnectRealtimeTestConnection,
  type RealtimeClientTestSetup,
} from "./realtime-client-test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sessionPayload(sessionId = "session-1") {
  return { sessionId };
}

function stopCommand(
  setup: RealtimeClientTestSetup,
  idempotencyKey: string,
): Promise<unknown> {
  return setup.connection.command(
    SESSION_REALTIME_OPERATIONS.stop,
    sessionPayload(),
    idempotencyKey,
  );
}

function commandSetup(commandId: string): RealtimeClientTestSetup {
  return commandRealtimeTestSetup(commandId);
}

function openedCommandSetup(commandId: string): RealtimeClientTestSetup {
  return commandRealtimeTestSetup(commandId, true);
}

function circularPayload(): Readonly<Record<string, unknown>> {
  const circular: Record<string, unknown> = {};
  Reflect.set(circular, "self", circular);
  return circular;
}

function expectNoMessagesSent(setup: RealtimeClientTestSetup): void {
  expect(setup.sockets[0]?.sent).toEqual([]);
}

async function expectRejectedWithoutSend(
  setup: RealtimeClientTestSetup,
  result: Promise<unknown>,
  error: string,
): Promise<void> {
  await expect(result).rejects.toThrow(error);
  expectNoMessagesSent(setup);
}

function expectOutcomeUnknown(result: Promise<unknown>): Promise<void> {
  const rejection = expect(result).rejects;
  return rejection.toMatchObject({
    code: "outcome_unknown",
    message: "outcome_unknown",
  });
}

async function acknowledgeSuccess(
  setup: RealtimeClientTestSetup,
  commandId: string,
  result: unknown,
  pending: Promise<unknown>,
): Promise<void> {
  setup.sockets.at(-1)?.receive({
    commandId,
    result,
    type: "command_success",
  });
  await expect(pending).resolves.toEqual(result);
}

test("correlates command success and error acknowledgements", async () => {
  const setup = commandSetup("command-1");
  openRealtimeTestConnection(setup, "instance-1");
  const result = setup.connection.command(
    SESSION_REALTIME_OPERATIONS.read,
    sessionPayload(),
    "read-1",
  );
  const envelope: unknown = JSON.parse(setup.sockets[0]?.sent[0] ?? "null");
  expect(envelope).toEqual(
    Object.fromEntries([
      ["commandId", "command-1"],
      ["idempotencyKey", "read-1"],
      ["operation", "sessions.read"],
      ["payload", { sessionId: "session-1" }],
      ["type", "command"],
    ]),
  );
  await acknowledgeSuccess(setup, "command-1", { status: "idle" }, result);
  setup.connection.stop();
});

test("queues commands until the initial ready handshake", async () => {
  const setup = commandSetup("command-before-ready");
  const result = setup.connection.command(
    SESSION_REALTIME_OPERATIONS.send,
    { prompt: "Continue", sessionId: "session-1" },
    "send-before-ready",
  );
  expectNoMessagesSent(setup);

  openRealtimeTestConnection(setup, "instance-1");
  if (setup.sockets[0]?.sent.length !== 1) {
    throw new Error("The queued command was not sent after ready");
  }
  await acknowledgeSuccess(
    setup,
    "command-before-ready",
    { status: "queued" },
    result,
  );
  setup.connection.stop();
});

test("rejects a queued command when the initial connection closes before ready", async () => {
  const setup = commandSetup("command-before-close");
  const result = setup.connection.command(
    SESSION_REALTIME_OPERATIONS.stop,
    sessionPayload(),
    "stop-before-close",
  );

  setup.sockets[0]?.close();

  await expectOutcomeUnknown(result);
  setup.connection.stop();
});

test("bounds commands queued while the connection is unavailable", async () => {
  const setup = commandSetup("queued-command");
  setup.sockets[0]?.close();
  const queued = Array.from({ length: 1_000 }, (_, index) =>
    setup.connection.command(SESSION_REALTIME_OPERATIONS.read, {
      sessionId: `session-${String(index)}`,
    }),
  );

  await expect(
    setup.connection.command(SESSION_REALTIME_OPERATIONS.read, {
      sessionId: "overflow",
    }),
  ).rejects.toThrow("command_capacity_exceeded");
  setup.connection.stop();
  await Promise.allSettled(queued);
});

test("rejects unserializable command payloads without throwing synchronously", async () => {
  const setup = commandSetup("circular-command");
  const result = setup.connection.command(
    SESSION_REALTIME_OPERATIONS.read,
    circularPayload(),
  );

  await expectRejectedWithoutSend(setup, result, "invalid_command");
  setup.connection.stop();
});

test.each(["outcome_unknown", "command_outcome_unknown"])(
  "normalizes server unknown-outcome code %s",
  async (error) => {
    const setup = openedCommandSetup(`evicted-${error}`);
    const result = stopCommand(setup, "stop-evicted");

    setup.sockets[0]?.receive({
      commandId: `evicted-${error}`,
      error,
      type: "command_error",
    });

    await expectOutcomeUnknown(result);
    setup.connection.stop();
  },
);

test("does not replay a command settled while reconnect listeners run", async () => {
  const setup = openedCommandSetup("settled-on-reconnect");
  const result = stopCommand(setup, "settled-on-reconnect");
  setup.sockets.at(-1)?.close();
  setup.connection.onReconnect(() => {
    setup.sockets[1]?.receive({
      commandId: "settled-on-reconnect",
      result: { status: "stopped" },
      type: "command_success",
    });
  });
  finishRealtimeTestReconnect(setup, "instance-1");

  await expect(result).resolves.toEqual({ status: "stopped" });
  expect(setup.sockets[1]?.sent).toHaveLength(1);
  setup.connection.stop();
});

test("replays only on the same server instance and rejects uncertain mutations", async () => {
  const same = commandSetup("command-1");
  openRealtimeTestConnection(same, "instance-1");
  const sameResult = same.connection.command(
    SESSION_REALTIME_OPERATIONS.send,
    { prompt: "Continue", sessionId: "session-1" },
    "send-1",
  );
  const exactEnvelope = same.sockets[0]?.sent[0];
  reconnectRealtimeTestConnection(same, "instance-1");
  expect(same.sockets[1]?.sent).toEqual([exactEnvelope]);
  await acknowledgeSuccess(same, "command-1", { status: "queued" }, sameResult);
  same.connection.stop();

  const changed = commandSetup("changed-command");
  openRealtimeTestConnection(changed, "instance-1");
  const changedResult = stopCommand(changed, "stop-1");
  reconnectRealtimeTestConnection(changed, "instance-2");
  await expectOutcomeUnknown(changedResult);
  expect(changed.sockets[1]?.sent).toEqual([]);
  changed.connection.stop();
});
