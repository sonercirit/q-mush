import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
} from "../shared/tool-stream.ts";

export interface ToolSyncRequest {
  readonly sessionId: string;
  readonly streamId: string;
}

export function toolSyncKey(request: ToolSyncRequest): string {
  return JSON.stringify([request.sessionId, request.streamId]);
}

export class ToolSyncTracker {
  readonly #pending = new Map<string, ToolSyncRequest>();
  readonly #sessionCounts = new Map<string, number>();

  clear(): void {
    this.#pending.clear();
    this.#sessionCounts.clear();
  }

  pending(): readonly ToolSyncRequest[] {
    return [...this.#pending.values()];
  }

  #delete(key: string): void {
    const request = this.#pending.get(key);
    if (request === undefined) return;
    this.#pending.delete(key);
    const count = (this.#sessionCounts.get(request.sessionId) ?? 1) - 1;
    if (count === 0) this.#sessionCounts.delete(request.sessionId);
    else this.#sessionCounts.set(request.sessionId, count);
  }

  remember(request: ToolSyncRequest): void {
    const key = toolSyncKey(request);
    this.#delete(key);
    this.#pending.set(key, request);
    this.#sessionCounts.set(
      request.sessionId,
      (this.#sessionCounts.get(request.sessionId) ?? 0) + 1,
    );
    while (
      (this.#sessionCounts.get(request.sessionId) ?? 0) >
      MAXIMUM_TOOL_STREAMS_PER_SESSION
    ) {
      for (const [candidateKey, pending] of this.#pending) {
        if (pending.sessionId !== request.sessionId) continue;
        this.#delete(candidateKey);
        break;
      }
    }
    while (this.#pending.size > MAXIMUM_TOOL_STREAMS_PER_USER) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#delete(oldest);
    }
  }

  resolve(request: ToolSyncRequest): void {
    this.#delete(toolSyncKey(request));
  }

  resolveSession(sessionId: string): void {
    for (const [key, request] of this.#pending) {
      if (request.sessionId === sessionId) this.#delete(key);
    }
  }

  unresolved(requests: readonly ToolSyncRequest[]): readonly ToolSyncRequest[] {
    const unique = new Map<string, ToolSyncRequest>();
    for (const request of requests) unique.set(toolSyncKey(request), request);
    return [...unique].flatMap(([key, request]) =>
      this.#pending.has(key) ? [] : [request],
    );
  }
}
