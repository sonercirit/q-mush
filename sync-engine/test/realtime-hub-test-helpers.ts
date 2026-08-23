import type { RealtimeSocket } from "../../sync-engine/realtime-hub.ts";

export interface RecordingRealtimeSocket extends RealtimeSocket {
  readonly messages: string[];
}

export function createRecordingRealtimeSocket(): RecordingRealtimeSocket {
  const messages: string[] = [];
  return {
    messages,
    close() {
      // Focused hub tests leave recording sockets open.
    },
    send(message) {
      messages.push(message);
      return message.length;
    },
  };
}
