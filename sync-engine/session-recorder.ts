import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";
import type { SessionStore } from "./session-store.ts";

export class SessionRecorder {
  readonly #generation: number;
  readonly #notify: () => void;
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #store: SessionStore;

  constructor(
    store: SessionStore,
    sessionId: string,
    now: () => number,
    notify: () => void,
    generation: number,
  ) {
    this.#generation = generation;
    this.#notify = () => {
      if (this.#store.executionIsCurrent(this.#sessionId, this.#generation)) {
        notify();
      }
    };
    this.#now = now;
    this.#sessionId = sessionId;
    this.#store = store;
  }

  #record(action: (now: number, generation: number) => void): void {
    action(this.#now(), this.#generation);
    this.#notify();
  }

  usage(input: AgentSessionUsageUpdate): void {
    this.#record((now, generation) => {
      this.#store.updateUsage(this.#sessionId, input, now, generation);
    });
  }

  message(message: AgentRecordedMessage): void {
    this.#record((now, generation) => {
      this.#store.appendAgentMessage(this.#sessionId, message, now, generation);
    });
  }
}
