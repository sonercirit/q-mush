export class ActiveSessionTools {
  readonly #active = new Map<string, Map<string, string>>();

  begin(sessionId: string, callId: string, tool: string): () => void {
    const session = this.#active.get(sessionId) ?? new Map<string, string>();
    session.set(callId, tool);
    this.#active.set(sessionId, session);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const current = this.#active.get(sessionId);
      current?.delete(callId);
      if (current?.size === 0) {
        this.#active.delete(sessionId);
      }
    };
  }

  names(sessionId: string): readonly string[] {
    return [...new Set(this.#active.get(sessionId)?.values() ?? [])];
  }
}
