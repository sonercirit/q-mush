import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
} from "../shared/tool-stream.ts";

export interface ToolSyncRequest {
  readonly sessionId: string;
  readonly streamId: string;
}

export interface ToolSyncTracker {
  clear(): void;
  pending(): readonly ToolSyncRequest[];
  remember(request: ToolSyncRequest): void;
  resolve(request: ToolSyncRequest): void;
  resolveSession(sessionId: string): void;
  unresolved(requests: readonly ToolSyncRequest[]): readonly ToolSyncRequest[];
}

export function toolSyncKey(request: ToolSyncRequest): string {
  return JSON.stringify([request.sessionId, request.streamId]);
}

export function createToolSyncTracker(): ToolSyncTracker {
  const pending = new Map<string, ToolSyncRequest>();
  const sessionCounts = new Map<string, number>();
  const deleteRequest = (key: string): void => {
    const request = pending.get(key);
    if (request === undefined) return;
    pending.delete(key);
    const count = (sessionCounts.get(request.sessionId) ?? 1) - 1;
    if (count === 0) sessionCounts.delete(request.sessionId);
    else sessionCounts.set(request.sessionId, count);
  };
  return {
    clear() {
      pending.clear();
      sessionCounts.clear();
    },
    pending: () => [...pending.values()],
    remember(request) {
      const key = toolSyncKey(request);
      deleteRequest(key);
      pending.set(key, request);
      sessionCounts.set(
        request.sessionId,
        (sessionCounts.get(request.sessionId) ?? 0) + 1,
      );
      while (
        (sessionCounts.get(request.sessionId) ?? 0) >
        MAXIMUM_TOOL_STREAMS_PER_SESSION
      ) {
        for (const [candidateKey, candidate] of pending) {
          if (candidate.sessionId !== request.sessionId) continue;
          deleteRequest(candidateKey);
          break;
        }
      }
      while (pending.size > MAXIMUM_TOOL_STREAMS_PER_USER) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        deleteRequest(oldest);
      }
    },
    resolve(request) {
      deleteRequest(toolSyncKey(request));
    },
    resolveSession(sessionId) {
      for (const [key, request] of pending) {
        if (request.sessionId === sessionId) deleteRequest(key);
      }
    },
    unresolved(requests) {
      const unique = new Map<string, ToolSyncRequest>();
      for (const request of requests) unique.set(toolSyncKey(request), request);
      return [...unique].flatMap(([key, request]) =>
        pending.has(key) ? [] : [request],
      );
    },
  };
}
