import { expect, test } from "vitest";
import {
  acknowledgeProviderSocket,
  apiKeyModel,
  complete,
  completeProviderSocket,
  createFakeProviderSockets,
  type FakeProviderSockets,
  requireProviderSocket,
} from "./provider-recovery-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

async function reusedModel(
  onDelta?: Parameters<typeof apiKeyModel>[0]["onDelta"],
) {
  const sockets = createFakeProviderSockets();
  const model = apiKeyModel({
    ...(onDelta === undefined ? {} : { onDelta }),
    webSocket: sockets.create,
  });
  const pendingFirst = complete(model);
  const socket = sockets.created.at(0);
  if (socket === undefined) throw new Error("Missing initial socket");
  socket.open();
  acknowledgeProviderSocket(socket, "prior");
  completeProviderSocket(socket, "prior");
  expectDoneStep(await pendingFirst);
  return { model, socket, sockets };
}

function finishReplacement(sockets: FakeProviderSockets) {
  const replacement = requireProviderSocket(sockets, 1);
  replacement.open();
  acknowledgeProviderSocket(replacement, "fresh");
  completeProviderSocket(replacement, "fresh");
}

function permanentError(message: string, responseId?: string) {
  return {
    error: { code: "invalid_api_key", message },
    ...(responseId === undefined ? {} : { response_id: responseId }),
    type: "error",
  };
}

test("discards a permanent error carrying a retained response ID", async () => {
  const { model, socket } = await reusedModel();
  const pending = complete(model);
  socket.receive(permanentError("Stale failure", "prior"));
  acknowledgeProviderSocket(socket, "current");
  completeProviderSocket(socket, "current");
  expectDoneStep(await pending);
});

test("surfaces a permanent pre-admission error on a reused socket", async () => {
  const prepared = await reusedModel();
  const pending = complete(prepared.model);
  prepared.socket.receive(permanentError("Invalid key"));
  await expect(pending).rejects.toThrow("Invalid key");
  expect(prepared.sockets.created).toHaveLength(1);
});

test("replays an ID-less admitted request after an unidentified permanent error", async () => {
  const { model, socket, sockets } = await reusedModel();
  const pending = complete(model);
  socket.receive({ type: "response.created" });
  expect(sockets.created).toHaveLength(1);
  socket.receive(permanentError("Stale failure"));
  await sockets.waitForAttempt(1);
  finishReplacement(sockets);
  expectDoneStep(await pending);
});

test("resets forwarded output when replaying a post-admission error", async () => {
  const deltas: { content: string; reset?: boolean }[] = [];
  const { model, socket, sockets } = await reusedModel((delta) =>
    deltas.push(delta),
  );
  const pending = complete(model);
  acknowledgeProviderSocket(socket, "current");
  socket.receive({
    delta: "Partial",
    response_id: "current",
    type: "response.output_text.delta",
  });
  socket.receive(permanentError("Invalid key"));
  await sockets.waitForAttempt(1);
  expect(deltas).toContainEqual({ content: "", reset: true, thinking: "" });
  finishReplacement(sockets);
  expectDoneStep(await pending);
});
