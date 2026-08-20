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
