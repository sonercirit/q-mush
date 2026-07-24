import type { RealtimeSocket } from "../../sync-engine/realtime-hub.ts";

class RecordingSocket implements RealtimeSocket {
  readonly messages: string[] = [];

  close(): void {
    // Test sockets stay open until explicitly removed from the hub.
  }

  send(message: string): number {
    this.messages.push(message);
    return message.length;
  }
}

export function createRecordingSocket(): RealtimeSocket & {
  readonly messages: string[];
} {
  return new RecordingSocket();
}

export { RecordingSocket };
