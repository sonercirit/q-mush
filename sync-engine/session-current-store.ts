import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import type { SessionStore } from "./session-store.ts";

export class CurrentSessionStore {
  readonly #generation: (sessionId: string) => number;
  readonly #store: SessionStore;

  constructor(store: SessionStore, generation: (sessionId: string) => number) {
    this.#generation = generation;
    this.#store = store;
  }

  appendAgentMessage(
    sessionId: string,
    message: AgentRecordedMessage,
    now: number,
  ): void {
    this.#store.appendRuntimeAgentMessages(
      sessionId,
      [message],
      now,
      this.#generation(sessionId),
    );
  }

  appendErrorMessage(sessionId: string, content: string, now: number): void {
    this.#store.appendRuntimeErrorMessage(
      sessionId,
      content,
      now,
      this.#generation(sessionId),
    );
  }

  compactConversation(
    sessionId: string,
    summary: string,
    usage: CompactionUsage,
    now: number,
  ): void {
    this.#store.compactRuntimeConversation(
      sessionId,
      summary,
      usage,
      now,
      this.#generation(sessionId),
      now,
    );
  }

  setAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
  ): void {
    this.#store.setRuntimeAgentFile(
      sessionId,
      agentFile,
      now,
      this.#generation(sessionId),
    );
  }

  updateUsage(
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
  ): void {
    this.#store.updateRuntimeUsage(
      sessionId,
      input,
      now,
      this.#generation(sessionId),
    );
  }

  transition(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
  ): boolean {
    try {
      return this.#store.transitionRuntime(
        sessionId,
        status,
        now,
        this.#generation(sessionId),
      );
    } catch {
      return false;
    }
  }
}
