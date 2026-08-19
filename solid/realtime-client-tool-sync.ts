export interface ToolSyncRequest {
  readonly sessionId: string;
  readonly streamId: string;
}

function requestKey(request: ToolSyncRequest): string {
  return JSON.stringify([request.sessionId, request.streamId]);
}

export class ToolSyncTracker {
  readonly #seenSnapshots = new Map<string, ToolSyncRequest>();

  clear(): void {
    this.#seenSnapshots.clear();
  }

  forget(request: ToolSyncRequest): void {
    this.#seenSnapshots.delete(requestKey(request));
  }

  rememberSnapshot(request: ToolSyncRequest): void {
    this.#seenSnapshots.set(requestKey(request), request);
  }

  requests(): readonly ToolSyncRequest[] {
    return [...this.#seenSnapshots.values()];
  }

  unseen(requests: readonly ToolSyncRequest[]): readonly ToolSyncRequest[] {
    return requests.filter(
      (request) => !this.#seenSnapshots.has(requestKey(request)),
    );
  }
}
