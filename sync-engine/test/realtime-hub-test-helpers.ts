import type { RealtimeSocket } from "../realtime-hub.ts";

export class TestRealtimeSocket implements RealtimeSocket {
  readonly messages: string[] = [];

  close(): void {
    // Test sockets stay open until explicitly removed from the hub.
  }

  send(message: string): number {
    this.messages.push(message);
    return message.length;
  }
}
