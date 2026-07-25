import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";
import type { SessionStore } from "./session-store.ts";

export class SessionRecorder {
  readonly #generation: number;
  readonly #notify: () => void;
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #store: SessionStore;
  readonly #userId: string;

  constructor(
    store: SessionStore,
    sessionId: string,
    now: () => number,
    notify: () => void,
    generation: number,
    userId: string,
  ) {
    this.#generation = generation;
    this.#notify = () => {
      if (
        this.#store.executionIsCurrent(
          this.#userId,
          this.#sessionId,
          this.#generation,
        )
      ) {
        notify();
      }
    };
    this.#now = now;
    this.#sessionId = sessionId;
    this.#store = store;
    this.#userId = userId;
  }

  #record(action: (now: number, generation: number) => void): void {
    action(this.#now(), this.#generation);
    this.#notify();
  }

  messages(
    messages: readonly AgentRecordedMessage[],
    usage?: AgentSessionUsageUpdate,
  ): void {
    this.#record((now, generation) => {
      this.#store.appendRuntimeAgentMessages(
        this.#sessionId,
        messages,
        now,
        generation,
        usage,
      );
    });
  }
}
