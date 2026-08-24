import type { RealtimeSocket } from "../../sync-engine/realtime-hub.ts";

export interface RecordingRealtimeSocket extends RealtimeSocket {
  readonly messages: string[];
}

export function createRecordingRealtimeSocket(): RecordingRealtimeSocket {
  const recordedMessages: string[] = [];
  return {
    close(): void {
      // Focused hub tests leave recording sockets open.
    },
    messages: recordedMessages,
    send(message): number {
      recordedMessages.push(message);
      return message.length;
    },
  };
}
