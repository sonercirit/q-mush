import type { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import type { RealtimeClientEvent } from "./realtime-stream-buffer.ts";

export interface BrowserWebSocket extends EventTarget {
  readonly readyState: number;
  close(): void;
  send(data: string): void;
}
export type BrowserWebSocketFactory = (url: string) => BrowserWebSocket;
export type FrameCallback = (callback: () => void) => number;
export type RealtimeListener = (event: RealtimeClientEvent) => void;
export type SessionRealtimeOperation =
  (typeof SESSION_REALTIME_OPERATIONS)[keyof typeof SESSION_REALTIME_OPERATIONS];
