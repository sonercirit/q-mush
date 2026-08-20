import { test } from "vitest";
import {
  acknowledgeProviderSocket,
  apiKeyModel,
  complete,
  COMPLETED_EVENT,
  FakeProviderSockets,
  requireProviderSocket,
} from "./provider-recovery-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

function responseEvent(id: string) {
  return {
    response: { ...COMPLETED_EVENT.response, id },
    type: "response.completed",
  };
}
async function requirePending(pending: Promise<unknown>): Promise<void> {
  const marker = Symbol("pending");
  const outcome = await Promise.race([
    pending,
    new Promise<symbol>((resolve) =>
      setTimeout(() => {
        resolve(marker);
      }, 0),
    ),
  ]);
  if (outcome !== marker)
    throw new Error("The request settled during admission");
}

test("rejects a terminal-only stale response during reused-socket admission", async () => {
  const sockets = new FakeProviderSockets(),
    factory = sockets.create,
    model = apiKeyModel({ webSocket: factory });
  const first = model.complete([{ content: "Again", role: "user" }]);
  const socket = requireProviderSocket(sockets, sockets.created.length - 1);
  socket.open();
  acknowledgeProviderSocket(socket, "first");
  socket.receive(responseEvent("first"));
  await first;
  const pending = complete(model);
  socket.receive(responseEvent("first"));
  await requirePending(pending);
  socket.receive({
    delta: "Done.",
    response_id: "second",
    type: "response.output_text.delta",
  });
  socket.receive(responseEvent("second"));
  expectDoneStep(await pending);
  socket.close();
});

test("close clears retained response IDs before a fresh connection", async () => {
  const sockets = new FakeProviderSockets();
  const createSocket = sockets.create;
  const model = apiKeyModel({ webSocket: createSocket });
  const first = model.complete([{ content: "Initial", role: "user" }]);
  const original = requireProviderSocket(sockets, sockets.created.length - 1);
  original.open();
  acknowledgeProviderSocket(original, "repeated");
  original.receive(responseEvent("repeated"));
  expectDoneStep(await first);
  model.close();
  const pending = complete(model);
  const fresh = requireProviderSocket(sockets, 1);
  fresh.open();
  fresh.receive(responseEvent("repeated"));
  expectDoneStep(await pending);
  fresh.close();
});

test("accepts terminal-only responses across consecutive steps", async () => {
  const sockets = new FakeProviderSockets(),
    model = apiKeyModel({ webSocket: sockets.create }),
    first = complete(model),
    socket = requireProviderSocket(sockets, 0);
  socket.open();
  socket.receive(responseEvent("first-terminal"));
  expectDoneStep(await first);
  const second = complete(model);
  socket.receive(responseEvent("second-terminal"));
  expectDoneStep(await second);
  socket.close();
});
