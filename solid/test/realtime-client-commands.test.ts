import { expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { RealtimeConnection } from "../../solid/realtime-client.ts";

const INSTANCE_ID = "server-instance-1";

class CommandSocket extends EventTarget {
  readonly sent = new Array<string>();
  readyState: number = WebSocket.OPEN;

  shutdown(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CustomEvent("close"));
  }

  closeSilently(): void {
    this.readyState = WebSocket.CLOSED;
  }

  close = this.closeSilently.bind(this);

  send(data: string): void {
    this.sent[this.sent.length] = data;
  }

  ready(instanceId = INSTANCE_ID): void {
    this.receive(JSON.stringify({ instanceId, type: "ready" }));
  }

  receive(data: string): void {
    const incoming = new MessageEvent("message", { data });
    this.dispatchEvent(incoming);
  }
}

function sentCommand(socket: CommandSocket | undefined): {
  readonly commandId: string;
  readonly idempotencyKey: string | undefined;
} {
  const value: unknown = JSON.parse(socket?.sent[0] ?? "null");
  if (!isRecord(value) || typeof value["commandId"] !== "string") {
    throw new Error("The realtime command was not sent");
  }
  const idempotencyKey = value["idempotencyKey"];
  if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
    throw new Error("The realtime idempotency key was invalid");
  }
  return { commandId: value["commandId"], idempotencyKey };
}

function commandConnection(): {
  readonly connection: RealtimeConnection;
  readonly sockets: CommandSocket[];
  readonly timers: (() => void)[];
} {
  const sockets = new Array<CommandSocket>();
  const timers = new Array<() => void>();
  const createSocket = (): CommandSocket => {
    const socket = new CommandSocket();
    sockets[sockets.length] = socket;
    return socket;
  };
  const rememberTimer = (callback: () => void): number => {
    timers[timers.length] = callback;
    return timers.length;
  };
  const connection = new RealtimeConnection(() => undefined, {
    clearTimeout: () => undefined,
    createSocket,
    location: { href: "https://qmush.example/app", protocol: "https:" },
    setTimeout: rememberTimer,
  });
  connection.start();
  const firstSocket = sockets.at(0);
  if (firstSocket !== undefined) {
    firstSocket.readyState = WebSocket.OPEN;
    firstSocket.dispatchEvent(new Event("open"));
    firstSocket.ready();
  }
  return { connection, sockets, timers };
}

function closeCurrentAndReconnect(
  harness: ReturnType<typeof commandConnection>,
): void {
  harness.sockets.at(0)?.shutdown();
  harness.timers.shift()?.();
}

function reconnect(
  harness: ReturnType<typeof commandConnection>,
  instanceId = INSTANCE_ID,
): CommandSocket | undefined {
  closeCurrentAndReconnect(harness);
  const socket = harness.sockets.at(1);
  if (socket === undefined) {
    return undefined;
  }
  if (socket.readyState === WebSocket.OPEN) {
    socket.dispatchEvent(new Event("open"));
    socket.ready(instanceId);
  }
  return harness.sockets.at(-1);
}

function acknowledge(
  socket: CommandSocket | undefined,
  commandId: string,
  result: unknown,
): void {
  socket?.receive(
    JSON.stringify({ commandId, result, type: "command_success" }),
  );
}

function settle(
  pending: Promise<unknown>,
  socket: CommandSocket | undefined,
  commandId: string,
  result: unknown,
): Promise<void> {
  acknowledge(socket, commandId, result);
  return expect(pending).resolves.toEqual(result);
}

interface CommandHarness {
  readonly harness: ReturnType<typeof commandConnection>;
  readonly pending: Promise<unknown>;
  readonly sent: ReturnType<typeof sentCommand>;
}

function commandHarness(
  operation: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): CommandHarness {
  const harness = commandConnection();
  const pending = harness.connection.command(
    operation,
    payload,
    idempotencyKey,
  );
  return { harness, pending, sent: sentCommand(harness.sockets.at(0)) };
}

test("retries an outstanding command with the same idempotency key after reconnect", async () => {
  const { harness, pending, sent } = commandHarness(
    "sessions.send",
    { prompt: "Only once", sessionId: "session-1" },
    "stable-mutation-key",
  );

  const reconnected = reconnect(harness);
  expect(sentCommand(reconnected)).toEqual(sent);

  await settle(pending, reconnected, sent.commandId, {
    sessionId: "session-1",
  });
  harness.connection.stop();
});

test("does not resend an unresolved command after the server restarts", async () => {
  const { harness, pending } = commandHarness("sessions.send", {
    prompt: "Only once",
    sessionId: "session-1",
  });

  const reconnected = reconnect(harness, "server-instance-2");

  expect(reconnected?.sent).toEqual([]);
  await expect(pending).rejects.toMatchObject({ code: "outcome_unknown" });
  harness.connection.stop();
});

test("does not treat a pre-open socket failure as a reconnect", () => {
  const harness = commandConnection();
  let reconnects = 0;
  harness.connection.onReconnect(() => {
    reconnects += 1;
  });

  closeCurrentAndReconnect(harness);
  const replacement = harness.sockets.at(1);
  if (replacement !== undefined) {
    replacement.shutdown();
  }
  harness.timers.shift()?.();
  const opened = harness.sockets.at(2);
  if (opened !== undefined) {
    opened.readyState = WebSocket.OPEN;
    opened.dispatchEvent(new Event("open"));
    opened.ready();
  }

  expect(reconnects).toBe(1);
  harness.connection.stop();
});

test("ignores stale command acknowledgements from a replaced socket", async () => {
  const staleAcknowledgements = [
    { result: { status: "stale" }, type: "command_success" },
    { error: "command_capacity_exceeded", type: "command_error" },
  ] as const;

  for (const stale of staleAcknowledgements) {
    const { harness, pending, sent } = commandHarness("sessions.stop", {
      sessionId: "session-1",
    });
    const reconnected = reconnect(harness);
    harness.sockets
      .at(0)
      ?.receive(JSON.stringify({ commandId: sent.commandId, ...stale }));
    await settle(pending, reconnected, sent.commandId, { status: "stopped" });
    harness.connection.stop();
  }
});

test("rejects unserializable commands without retaining pending work", async () => {
  const harness = commandConnection();
  const payload: Record<string, unknown> = {};
  payload["self"] = payload;

  await expect(
    harness.connection.command("sessions.send", payload),
  ).rejects.toMatchObject({ code: "invalid_command" });
  expect(harness.sockets.at(0)?.sent).toEqual([]);
  harness.connection.stop();
});

test("bounds commands queued while disconnected", async () => {
  const harness = commandConnection();
  harness.sockets.at(0)?.shutdown();
  const queued = Array.from({ length: 1_000 }, (_, index) =>
    harness.connection.command("sessions.read", {
      sessionId: `session-${String(index)}`,
    }),
  );

  await expect(
    harness.connection.command("sessions.read", { sessionId: "overflow" }),
  ).rejects.toMatchObject({ code: "command_capacity_exceeded" });
  harness.connection.stop();
  await Promise.allSettled(queued);
});

test("resolves a replayed acknowledgement once and rejects pending work on stop", async () => {
  const harness = commandConnection();
  const first = harness.connection.command(
    "sessions.subscribe",
    {},
    "subscription-1",
  );
  const firstCommandId = sentCommand(harness.sockets.at(0)).commandId;
  acknowledge(harness.sockets.at(0), firstCommandId, { sessions: [] });
  await expect(first).resolves.toEqual({ sessions: [] });

  const pending = harness.connection.command("sessions.read", {
    sessionId: "session-1",
  });
  harness.connection.stop();
  await expect(pending).rejects.toMatchObject({ code: "connection_stopped" });
});
