import { expect, test } from "vitest";
import {
  RunnerRestartCoordinator,
  type RunnerRestartSocket,
} from "../../runner/runner-restart.ts";

class TestSocket extends EventTarget implements RunnerRestartSocket {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  emit(type: "close" | "error" | "message", data = ""): void {
    if (type === "close") {
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent(type));
    } else if (type === "error") {
      this.dispatchEvent(new Event(type));
    } else {
      this.dispatchEvent(new MessageEvent(type, { data }));
    }
  }

  send(message: string): void {
    this.sent.push(message);
  }
}

function coordinator(restartId: string): RunnerRestartCoordinator {
  return new RunnerRestartCoordinator({ restartId: () => restartId });
}

test("waits for one matching durable runner restart acknowledgement", async () => {
  const socket = new TestSocket();
  const restart = coordinator("restart-1");
  const first = restart.request(socket);
  const duplicate = restart.request(socket);

  expect(duplicate).toBe(first);
  expect(socket.sent).toHaveLength(1);
  expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
    restartId: "restart-1",
    type: "restart",
  });
  socket.emit(
    "message",
    JSON.stringify({ restartId: "another-restart", type: "restart_ready" }),
  );
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  socket.emit(
    "message",
    JSON.stringify({ restartId: "restart-1", type: "restart_ready" }),
  );
  await expect(first).resolves.toBeUndefined();
});

test("does not restart after the coordinating connection is lost", async () => {
  const socket = new TestSocket();
  const restart = coordinator("restart-2").request(socket);

  socket.emit("close");
  await expect(restart).rejects.toThrow("before restart was safe");
});

test("does not restart after the coordinating connection errors", async () => {
  const socket = new TestSocket();
  const restart = coordinator("restart-error").request(socket);

  socket.emit("error");
  await expect(restart).rejects.toThrow("connection failed");
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

test("rejects a closed or replacement coordinating connection", async () => {
  const firstSocket = new TestSocket();
  const secondSocket = new TestSocket();
  const restart = coordinator("restart-3");
  const pending = restart.request(firstSocket);

  await expect(restart.request(secondSocket)).rejects.toThrow("replaced");
  firstSocket.emit("close");
  await expect(pending).rejects.toThrow("before restart was safe");
  await expect(restart.request(firstSocket)).rejects.toThrow("disconnected");
});
