import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";
import type { SessionStore } from "./session-store.ts";

export class SessionRecorder {
  readonly #notify: () => void;
  readonly #now: () => number;
  readonly #sessionId: string;
  readonly #store: Pick<SessionStore, "appendAgentMessage" | "updateUsage">;

  constructor(
    store: Pick<SessionStore, "appendAgentMessage" | "updateUsage">,
    sessionId: string,
    now: () => number,
    notify: () => void,
  ) {
    this.#notify = notify;
    this.#now = now;
    this.#sessionId = sessionId;
    this.#store = store;
  }

  usage(input: AgentSessionUsageUpdate): void {
    this.#store.updateUsage(this.#sessionId, input, this.#now());
    this.#notify();
  }

  message(message: AgentRecordedMessage): void {
    this.#store.appendAgentMessage(this.#sessionId, message, this.#now());
    this.#notify();
  }
}
