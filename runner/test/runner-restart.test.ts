import { expect, test } from "vitest";
import {
  RunnerRestartCoordinator,
  type RunnerRestartSocket,
} from "../../runner/runner-restart.ts";

class TestSocket extends EventTarget implements RunnerRestartSocket {
  readyState: number = WebSocket.OPEN;
  readonly #sent: string[] = [];

  get sent(): readonly string[] {
    return this.#sent;
  }

  async completeRestart(
    restartId: string,
    attempt: Promise<string>,
  ): Promise<void> {
    this.emitAcknowledgement(restartId);
    await expect(attempt).resolves.toBe(restartId);
  }

  emitAcknowledgement(restartId: string): void {
    const data = JSON.stringify({ restartId, type: "restart_ready" });
    const event = new MessageEvent("message", { data });
    this.dispatchEvent(event);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    const event = new CloseEvent("close");
    this.dispatchEvent(event);
  }

  send(message: string): void {
    this.#sent.push(message);
  }
}

function coordinator(restartId: string): RunnerRestartCoordinator {
  return new RunnerRestartCoordinator({ restartId: () => restartId });
}

function incrementalCoordinator(generated: { count: number }) {
  return new RunnerRestartCoordinator({
    restartId: () => `restart-${String((generated.count += 1))}`,
  });
}

function incrementalFixture() {
  const generated = { count: 0 };
  return { generated, restart: incrementalCoordinator(generated) };
}

function restartFixture(restartId = "restart-1") {
  return {
    restart: coordinator(restartId),
    sockets: [new TestSocket(), new TestSocket()] as const,
  };
}

interface ReplacementFixture {
  readonly restart: RunnerRestartCoordinator;
  readonly secondAttempt: Promise<string>;
  readonly sockets: readonly [TestSocket, TestSocket];
}

async function replaceCoordinatingConnection(
  restartId: string,
): Promise<ReplacementFixture> {
  const { restart, sockets } = restartFixture(restartId);
  const firstAttempt = restart.request(sockets[0]);
  const secondAttempt = restart.request(sockets[1]);
  await expect(firstAttempt).rejects.toThrow("replaced");
  return { restart, secondAttempt, sockets };
}

function restartRequest(
  restartId: string,
  type: "restart" | "restart_escalate" = "restart",
): string {
  return JSON.stringify({ restartId, type });
}

async function expectDurableRetry(
  generated: { count: number },
  socket: TestSocket,
  attempt: Promise<string>,
  type: "restart" | "restart_escalate" = "restart",
  restartId = "restart-1",
  expectedCount = 1,
): Promise<void> {
  expect(socket.sent).toEqual([JSON.stringify({ restartId, type })]);
  expect(generated.count).toBe(expectedCount);
  await socket.completeRestart(restartId, attempt);
}

async function nextRestartAttempt(
  restart: RunnerRestartCoordinator,
  generated: { count: number },
  restartId = "restart-1",
  expectedCount = 1,
): Promise<void> {
  const socket = new TestSocket();
  await expectDurableRetry(
    generated,
    socket,
    restart.request(socket),
    "restart",
    restartId,
    expectedCount,
  );
}

async function expectPending(promise: Promise<string>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

test("restores a startup restart for safe same-lifecycle retries", async () => {
  const socket = new TestSocket();
  const restart = coordinator("unused");
  restart.restore("restart-restored");

  const attempt = restart.request(socket);
  expect(socket.sent).toEqual([
    restartRequest("restart-restored", "restart_escalate"),
  ]);
  await socket.completeRestart("restart-restored", attempt);
});

test("includes a pending pre-acknowledgement restart in reconnect context", async () => {
  const { restart, sockets } = restartFixture("restart-connect");
  const pending = restart.request(sockets[0]);

  const context = restart.connectionContext({
    activationReceipt: "receipt-1",
    restartId: "startup-restart",
  });
  expect(context.restartId).toBe("restart-connect");
  expect(context.activationReceipt).toBe("receipt-1");
  sockets[0].close();
  await expect(pending).rejects.toThrow("before restart was safe");
});

test("clears an acknowledged restart once the replacement is operational", async () => {
  const socket = new TestSocket();
  const { generated, restart } = incrementalFixture();
  const first = restart.request(socket);

  socket.emitAcknowledgement("restart-1");
  await expect(first).resolves.toBe("restart-1");
  expect(restart.connectionContext({})).toEqual({ restartId: "restart-1" });

  expect(restart.operational("restart-1")).toBe(true);
  expect(restart.pending).toBe(false);
  expect(restart.connectionContext({})).toEqual({});

  await nextRestartAttempt(restart, generated, "restart-2", 2);
});

test("clears a restart when replacement operation precedes a delayed ready frame", async () => {
  const socket = new TestSocket();
  const restart = coordinator("restart-delayed-ready");
  const attempt = restart.request(socket);

  expect(restart.operational("restart-delayed-ready")).toBe(true);
  expect(restart.pending).toBe(true);
  socket.emitAcknowledgement("restart-delayed-ready");
  await expect(attempt).resolves.toBe("restart-delayed-ready");
  expect(restart.pending).toBe(false);
});

test("retains the acknowledged restart ID for replacement launch", async () => {
  const { restart, sockets } = restartFixture("restart-connect");
  const attempt = restart.request(sockets[1]);

  expect(restart.pendingRestartId).toBe("restart-connect");
  await sockets[1].completeRestart("restart-connect", attempt);
  expect(restart.pendingRestartId).toBe("restart-connect");
});

test("waits for one matching durable runner restart acknowledgement", async () => {
  const socket = new TestSocket();
  const restart = coordinator("restart-1");
  const first = restart.request(socket);
  const duplicate = restart.request(socket);

  expect(duplicate).toBe(first);
  expect(socket.sent).toEqual([
    restartRequest("restart-1"),
    restartRequest("restart-1", "restart_escalate"),
  ]);
  expect(restart.pendingRestartId).toBe("restart-1");
  socket.emitAcknowledgement("another-restart");
  await expectPending(first);
  await socket.completeRestart("restart-1", first);
  expect(restart.pendingRestartId).toBe("restart-1");
});

type RestartRetryPreparation = "acknowledge" | "disconnect";

async function retryPendingRestart(
  restart: RunnerRestartCoordinator,
  sockets: readonly [TestSocket, TestSocket],
  preparation: RestartRetryPreparation,
): Promise<void> {
  const generated = { count: 1 };
  const firstAttempt = restart.request(sockets[0]);
  if (preparation === "disconnect") {
    sockets[0].close();
    await expect(firstAttempt).rejects.toThrow("before restart was safe");
  } else {
    await sockets[0].completeRestart("restart-1", firstAttempt);
  }
  await expectDurableRetry(
    generated,
    sockets[1],
    restart.request(sockets[1]),
    "restart_escalate",
  );
}

test.each([
  ["lost coordinating connection", "disconnect"],
  ["post-acknowledgement update failure", "acknowledge"],
] as const)(
  "retries the same restart after %s",
  async (_label, preparation) => {
    const { restart, sockets } = restartFixture();

    await retryPendingRestart(restart, sockets, preparation);
    if (preparation === "disconnect") {
      expect(sockets.map(({ sent }) => sent)).toEqual([
        [restartRequest("restart-1")],
        [restartRequest("restart-1", "restart_escalate")],
      ]);
    }
  },
);

test("binds only the replacement coordinating connection", async () => {
  const acknowledged = await replaceCoordinatingConnection("restart-replaced");
  acknowledged.sockets[0].emitAcknowledgement("restart-replaced");
  await expectPending(acknowledged.secondAttempt);
  await acknowledged.sockets[1].completeRestart(
    "restart-replaced",
    acknowledged.secondAttempt,
  );

  const disconnected = await replaceCoordinatingConnection("restart-3");
  disconnected.sockets[0].close();
  await expect(
    disconnected.restart.request(disconnected.sockets[0]),
  ).rejects.toThrow("disconnected");
  await disconnected.sockets[1].completeRestart(
    "restart-3",
    disconnected.secondAttempt,
  );
});

test("rejects invalid generated restart IDs", async () => {
  const socket = new TestSocket();

  await expect(coordinator("").request(socket)).rejects.toThrow(
    "ID is invalid",
  );
  await expect(coordinator("x".repeat(201)).request(socket)).rejects.toThrow(
    "ID is invalid",
  );
  expect(socket.sent).toEqual([]);
});

test("a failed restart send can retry the same durable restart ID", async () => {
  class ThrowingSocket extends TestSocket {
    override send(): void {
      throw new Error("send failed");
    }
  }
  const failedSocket = new ThrowingSocket();
  const { generated, restart } = incrementalFixture();

  await expect(restart.request(failedSocket)).rejects.toThrow("send failed");
  await nextRestartAttempt(restart, generated);
});
