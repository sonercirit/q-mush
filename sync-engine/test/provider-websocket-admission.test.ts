import { expect, test } from "vitest";
import {
  acknowledgeProviderSocket,
  apiKeyModel,
  complete,
  COMPLETED_EVENT,
  FakeProviderSockets,
  requireProviderSocket,
} from "./provider-recovery-fixtures.ts";
import { expectDoneStep } from "./provider-step-fixtures.ts";

// jscpd:ignore-start
function responseEvent(id: string) {
  return {
    response: { ...COMPLETED_EVENT.response, id },
    type: "response.completed",
  };
}
async function expectPending(pending: Promise<unknown>): Promise<void> {
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
}

// jscpd:ignore-end

// jscpd:ignore-start
test("rejects a terminal-only stale response during reused-socket admission", async () => {
  const sockets = new FakeProviderSockets();
  const model = apiKeyModel({ webSocket: sockets.create });
  const first = complete(model);
  const socket = requireProviderSocket(sockets, 0);
  socket.open();
  acknowledgeProviderSocket(socket, "first");
  socket.receive(responseEvent("first"));
  await first;
  const pending = complete(model);
  socket.receive(responseEvent("stale-terminal"));
  await expectPending(pending);
  socket.receive({
    delta: "Done.",
    response_id: "second",
    type: "response.output_text.delta",
  });
  socket.receive(responseEvent("second"));
  expectDoneStep(await pending);
  socket.close();
});
// jscpd:ignore-end

test("close clears retained response IDs before a fresh connection", async () => {
  const sockets = new FakeProviderSockets(),
    model = apiKeyModel({ webSocket: sockets.create }),
    first = complete(model),
    original = requireProviderSocket(sockets, 0);
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
