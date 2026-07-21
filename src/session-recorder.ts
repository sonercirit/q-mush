import type { AgentRecordedMessage } from "./agent-loop.ts";
import type { SessionStore } from "./session-store.ts";

export class SessionRecorder {
  readonly #notify: () => void;
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #store: SessionStore;

  constructor(
    store: SessionStore,
    sessionId: string,
    now: () => number,
    notify: () => void,
  ) {
    this.#notify = notify;
    this.#now = now;
    this.#sessionId = sessionId;
    this.#store = store;
  }

  contextTokens(tokens: number): void {
    this.#store.updateContextTokens(this.#sessionId, tokens, this.#now());
    this.#notify();
  }

  message(message: AgentRecordedMessage): void {
    this.#store.appendAgentMessage(this.#sessionId, message, this.#now());
    this.#notify();
  }
}
