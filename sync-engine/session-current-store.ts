import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import type { SessionStore } from "./session-store.ts";

export interface CurrentSessionStore {
  appendAgentMessage(
    sessionId: string,
    message: AgentRecordedMessage,
    now: number,
  ): void;
  appendErrorMessage(sessionId: string, content: string, now: number): void;
  compactConversation(
    sessionId: string,
    summary: string,
    usage: CompactionUsage,
    now: number,
  ): void;
  setAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
  ): void;
  updateUsage(
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
  ): void;
  transition(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
  ): boolean;
}

export function createCurrentSessionStore(
  store: SessionStore,
  generation: (sessionId: string) => number,
): CurrentSessionStore {
  return {
    appendAgentMessage(sessionId, message, now) {
      store.appendRuntimeAgentMessages(
        sessionId,
        [message],
        now,
        generation(sessionId),
      );
    },
    appendErrorMessage(sessionId, content, now) {
      store.appendRuntimeErrorMessage(
        sessionId,
        content,
        now,
        generation(sessionId),
      );
    },
    compactConversation(sessionId, summary, usage, now) {
      store.compactRuntimeConversation(
        sessionId,
        summary,
        usage,
        now,
        generation(sessionId),
        now,
      );
    },
    setAgentFile(sessionId, agentFile, now) {
      store.setRuntimeAgentFile(
        sessionId,
        agentFile,
        now,
        generation(sessionId),
      );
    },
    updateUsage(sessionId, input, now) {
      store.updateRuntimeUsage(sessionId, input, now, generation(sessionId));
    },
    transition(sessionId, status, now) {
      try {
        return store.transitionRuntime(
          sessionId,
          status,
          now,
          generation(sessionId),
        );
      } catch {
        return false;
      }
    },
  };
}
