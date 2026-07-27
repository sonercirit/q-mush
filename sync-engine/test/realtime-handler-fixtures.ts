import type { QmushWebSocketData } from "../realtime.ts";
import type { RealtimeTestSocket } from "./realtime-test-socket-helpers.ts";

export function realtimeSocketMessage(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
  message: string,
): unknown {
  const method: unknown = Reflect.get(handler, "message");
  if (typeof method !== "function") {
    throw new TypeError("The realtime message handler is unavailable");
  }
  return Reflect.apply(method, undefined, [socket, message]);
}

export function sendRealtimeMessage(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
  message: unknown,
): unknown {
  return realtimeSocketMessage(handler, socket, JSON.stringify(message));
}

export function openRealtimeSocket(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
): void {
  const open: unknown = Reflect.get(handler, "open");
  if (typeof open !== "function") {
    throw new TypeError("The realtime open handler is unavailable");
  }
  Reflect.apply(open, undefined, [socket]);
}

export function closeRealtimeSocket(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
): void {
  const close: unknown = Reflect.get(handler, "close");
  if (typeof close !== "function") {
    throw new TypeError("The realtime close handler is unavailable");
  }
  Reflect.apply(close, undefined, [socket]);
}
