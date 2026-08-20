import { expect, test } from "vitest";
import {
  acknowledgeProviderSocket,
  apiKeyModel,
  complete,
  completeProviderSocket,
  FakeProviderSockets,
  replaceProviderSocket,
  requireProviderSocket,
  retryingSocket,
} from "./provider-recovery-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

test("does not adopt a retained ID after unidentified admission", async () => {
  const setup = new FakeProviderSockets();
  const model = apiKeyModel({ webSocket: setup.create });
  const first = complete(model);
  const socket = requireProviderSocket(setup, 0);
  socket.open();
  acknowledgeProviderSocket(socket, "retained");
  completeProviderSocket(socket, "retained");
  expectDoneStep(await first);

  const second = complete(model);
  socket.receive({ type: "response.created" });
  socket.receive({
    delta: "Stale.",
    response_id: "retained",
    type: "response.output_text.delta",
  });
  socket.receive({
    response_id: "current",
    sequence_number: 1,
    type: "response.output_text.delta",
    delta: "Done.",
  });
  completeProviderSocket(socket, "current");
  expectDoneStep(await second);
  socket.close();
});

test("retries a late prior-response error on a reused socket", async () => {
  const setup = new FakeProviderSockets();
  const createSocket = setup.create;
  const model = apiKeyModel({ webSocket: createSocket });
  const first = complete(model);
  const reused = requireProviderSocket(setup, 0);
  reused.open();
  acknowledgeProviderSocket(reused, "prior");
  completeProviderSocket(reused, "prior");
  expectDoneStep(await first);

  const firstBody = reused.sent[0];
  const second = complete(model);
  expect(reused.sent[1]).toBe(firstBody);
  reused.receive({
    error: { code: "late_error", message: "Stale failure" },
    type: "error",
  });
  await setup.waitForAttempt(1);
  const replacement = requireProviderSocket(setup, 1);
  replacement.open();
  expect(replacement.sent).toEqual([firstBody]);
  expect(reused.readyState).toBe(WebSocket.CLOSED);
  expect(reused.closeReason).toBe("Uncorrelated provider error");
  acknowledgeProviderSocket(replacement, "fresh");
  completeProviderSocket(replacement, "fresh");
  expectDoneStep(await second);
});

test("retries provider errors received before admission", async () => {
  const retry = retryingSocket();
  const first = requireProviderSocket(retry.sockets, 0);
  first.open();
  first.receive({
    error: { code: "server_error", message: "Try again" },
    type: "error",
  });
  await replaceProviderSocket(retry.sockets);
  expectDoneStep(await retry.pending);
  expect(retry.delays).toEqual([1_000]);
});
