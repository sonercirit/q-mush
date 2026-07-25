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

  usage(input: AgentSessionUsageUpdate): void {
    this.#record((now, generation) => {
      this.#store.updateRuntimeUsage(this.#sessionId, input, now, generation);
    });
  }

  message(message: AgentRecordedMessage): void {
    this.#record((now, generation) => {
      this.#store.appendRuntimeAgentMessage(
        this.#sessionId,
        message,
        now,
        generation,
      );
    });
  }
}
