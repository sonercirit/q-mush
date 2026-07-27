import { vi } from "vitest";
import { realtimeTestSetup } from "./realtime-client-test-setup.ts";

export type RealtimeClientTestSetup = ReturnType<typeof realtimeTestSetup>;

export function commandRealtimeTestSetup(
  commandId: string,
  opened = false,
): RealtimeClientTestSetup {
  vi.stubGlobal("crypto", { randomUUID: () => commandId });
  const setup = realtimeTestSetup({ requestFrame: () => 1 });
  if (opened) {
    openRealtimeTestConnection(setup, "instance-1");
  }
  return setup;
}

function realtimeTestSocket(setup: RealtimeClientTestSetup) {
  return setup.sockets.at(-1);
}

export function openRealtimeTestConnection(
  setup: RealtimeClientTestSetup,
  instanceId: string,
): void {
  realtimeTestSocket(setup)?.open(instanceId);
}

export function finishRealtimeTestReconnect(
  setup: RealtimeClientTestSetup,
  instanceId: string,
): void {
  setup.timers.shift()?.();
  openRealtimeTestConnection(setup, instanceId);
}

export function reconnectRealtimeTestConnection(
  setup: RealtimeClientTestSetup,
  instanceId: string,
): void {
  realtimeTestSocket(setup)?.close();
  finishRealtimeTestReconnect(setup, instanceId);
}

export function openAndReconnectRealtimeTestConnection(
  setup: RealtimeClientTestSetup,
  instanceId: string,
): void {
  openRealtimeTestConnection(setup, instanceId);
  reconnectRealtimeTestConnection(setup, instanceId);
}
