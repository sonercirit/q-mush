import { expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { RealtimeConnection } from "../../solid/realtime-client.ts";

class CommandSocket extends EventTarget {
  readonly sent = new Array<string>();
  readyState: number = WebSocket.OPEN;

  shutdown(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CustomEvent("close"));
  }

  close = this.shutdown.bind(this);

  send(data: string): void {
    this.sent[this.sent.length] = data;
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
  sockets.at(0)?.dispatchEvent(new Event("open"));
  return { connection, sockets, timers };
}

function reconnect(
  harness: ReturnType<typeof commandConnection>,
): CommandSocket | undefined {
  harness.sockets.at(0)?.shutdown();
  harness.timers.shift()?.();
  const socket = harness.sockets.at(1);
  socket?.dispatchEvent(new Event("open"));
  return socket;
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

test("ignores stale acknowledgements from a replaced socket", async () => {
  const { harness, pending, sent } = commandHarness("sessions.stop", {
    sessionId: "session-1",
  });

  const reconnected = reconnect(harness);
  acknowledge(harness.sockets.at(0), sent.commandId, { status: "stale" });
  await settle(pending, reconnected, sent.commandId, { status: "stopped" });
  harness.connection.stop();
});

test("resolves a replayed acknowledgement once and rejects pending work on stop", async () => {
  const harness = commandConnection();
  const first = harness.connection.command(
    "sessions.subscribe",
    {},
    "subscription-1",
  );
  acknowledge(
    harness.sockets.at(0),
    sentCommand(harness.sockets.at(0)).commandId,
    { sessions: [] },
  );
  await expect(first).resolves.toEqual({ sessions: [] });

  const pending = harness.connection.command("sessions.read", {
    sessionId: "session-1",
  });
  harness.connection.stop();
  await expect(pending).rejects.toEqual({ code: "connection_stopped" });
});
