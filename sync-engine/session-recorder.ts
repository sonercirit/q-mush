import type {
  SessionRecordedOutput,
  SessionTerminalOutput,
} from "./session-recorder-types.ts";
import { invokeRuntimeWrite } from "./session-runtime-write.ts";
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
    invokeRuntimeWrite(this.#now, this.#generation, action, this.#notify);
  }

  messages(...[messages, usage]: SessionRecordedOutput): void {
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

  terminal(...[messages, restartHandoff, usage]: SessionTerminalOutput): void {
    this.#record((now, generation) => {
      this.#store.commitRuntimeTerminal(
        this.#sessionId,
        messages,
        now,
        generation,
        restartHandoff,
        usage,
      );
    });
  }
}
