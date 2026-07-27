import type { RealtimeSocket } from "../../sync-engine/realtime-hub.ts";

export class RecordingRealtimeSocket implements RealtimeSocket {
  readonly messages: string[] = [];

  close(): void {
    // Focused hub tests leave recording sockets open.
  }

  send(message: string): number {
    this.messages.push(message);
    return message.length;
  }
}
