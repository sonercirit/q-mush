import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
} from "../shared/tool-stream.ts";

export interface ToolSyncRequest {
  readonly sessionId: string;
  readonly streamId: string;
}

function toolSyncKey(request: ToolSyncRequest): string {
  return JSON.stringify([request.sessionId, request.streamId]);
}

export class ToolSyncTracker {
  readonly #pending = new Map<string, ToolSyncRequest>();

  clear(): void {
    this.#pending.clear();
  }

  pending(): readonly ToolSyncRequest[] {
    return [...this.#pending.values()];
  }

  remember(request: ToolSyncRequest): void {
    const key = toolSyncKey(request);
    this.#pending.delete(key);
    this.#pending.set(key, request);
    let sessionEntries = 0;
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === request.sessionId) sessionEntries += 1;
    }
    while (sessionEntries > MAXIMUM_TOOL_STREAMS_PER_SESSION) {
      for (const [candidateKey, pending] of this.#pending) {
        if (pending.sessionId !== request.sessionId) continue;
        this.#pending.delete(candidateKey);
        sessionEntries -= 1;
        break;
      }
    }
    while (this.#pending.size > MAXIMUM_TOOL_STREAMS_PER_USER) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
  }

  resolve(request: ToolSyncRequest): void {
    this.#pending.delete(toolSyncKey(request));
  }

  resolveSession(sessionId: string): void {
    for (const [key, request] of this.#pending) {
      if (request.sessionId === sessionId) this.#pending.delete(key);
    }
  }

  unresolved(requests: readonly ToolSyncRequest[]): readonly ToolSyncRequest[] {
    return requests.filter(
      (request) => !this.#pending.has(toolSyncKey(request)),
    );
  }
}
