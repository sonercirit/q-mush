import { expect } from "vitest";
import type { ChatCompletionsAgentModel } from "../../sync-engine/agent-model.ts";
import { captureRejection } from "./promise-test-helpers.ts";
import {
  apiKeyModel,
  complete,
  COMPLETED_EVENT,
  completeProviderSocket,
  FakeProviderSockets,
  requireProviderSocket,
} from "./provider-recovery-fixtures.ts";

export class InstrumentedAbortController extends AbortController {
  abortListenerCount = 0;
  constructor() {
    super();
    const signal = this.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) => {
      if (type === "abort") this.abortListenerCount += 1;
      add(type, listener, options);
    };
    signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: EventListenerOptions | boolean,
    ) => {
      if (type === "abort") this.abortListenerCount -= 1;
      remove(type, listener, options);
    };
  }
}
export function completeWithSignal(
  model: ChatCompletionsAgentModel,
  signal: AbortSignal,
) {
  return model.complete([{ content: "Hello", role: "user" }], signal);
}
export function instrumentedProviderRequest() {
  const controller = new InstrumentedAbortController();
  const sockets = new FakeProviderSockets();
  const model = apiKeyModel({ webSocket: sockets.create });
  const pending = completeWithSignal(model, controller.signal);
  const socket = requireProviderSocket(sockets, 0);
  socket.open();
  return { controller, pending, socket };
}
export function lifecycleModel(states: ("active" | "admission")[]) {
  const sockets = new FakeProviderSockets();
  return {
    model: apiKeyModel({
      onRequestState: (state) => states.push(state),
      webSocket: sockets.create,
    }),
    sockets,
  };
}
export function beginLifecycleRequest(states: ("active" | "admission")[]) {
  const { model, sockets } = lifecycleModel(states);
  const pending = complete(model);
  const socket = requireProviderSocket(sockets, 0);
  socket.open();
  expectRequestStates(states, "admission");
  return { model, pending, socket, sockets };
}
export function responseEvent(
  type: "response.completed" | "response.created",
  id: string,
) {
  return {
    response:
      type === "response.created"
        ? { id }
        : { ...COMPLETED_EVENT.response, id },
    type,
  };
}
export { completeProviderSocket as completeResponse };
export async function expectRequestPending(
  pending: Promise<unknown>,
): Promise<void> {
  let settled = false;
  const observeSettlement = (): void => {
    settled = true;
  };
  void pending.then(observeSettlement, observeSettlement);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
}
export function expectRequestStates(
  states: readonly ("active" | "admission")[],
  ...expected: ("active" | "admission")[]
): void {
  expect(states).toEqual(expected);
}
export async function expectAbortWithoutHttp(
  model: ChatCompletionsAgentModel,
  controller: AbortController,
  interrupt: () => void,
): Promise<void> {
  const pending = completeWithSignal(model, controller.signal);
  interrupt();
  expect(await captureRejection(pending)).toMatchObject({ name: "AbortError" });
}
