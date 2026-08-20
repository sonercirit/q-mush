import { expect, test } from "vitest";
import {
  apiKeyModel,
  complete,
  FakeProviderSockets,
  replaceProviderSocket,
  requireProviderSocket,
  retryingSocket,
} from "./provider-recovery-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

test("adopts an ID observed after unidentified admission", async () => {
  const setup = new FakeProviderSockets();
  const model = apiKeyModel({ webSocket: setup.create });
  const pending = complete(model);
  const socket = requireProviderSocket(setup, 0);
  socket.open();
  socket.receive({ type: "response.created" });
  socket.receive({
    delta: "Done.",
    response_id: "identified-later",
    type: "response.output_text.delta",
  });
  socket.receive({
    response: { id: "identified-later", output: [] },
    type: "response.completed",
  });
  expectDoneStep(await pending);
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
