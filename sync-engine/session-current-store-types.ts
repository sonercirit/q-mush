import type { AgentFile } from "../shared/agent-file.ts";
import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";

export interface CurrentSessionStoreMethods {
  appendCurrentAgentMessage(
    sessionId: string,
    message: AgentRecordedMessage,
    now: number,
  ): void;
  appendCurrentErrorMessage(
    sessionId: string,
    content: string,
    now: number,
  ): void;
  compactCurrentConversation(
    sessionId: string,
    summary: string,
    usage: CompactionUsage,
    now: number,
  ): void;
  setCurrentAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
  ): void;
  transitionCurrent(
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
  ): boolean;
  updateCurrentUsage(
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
  ): void;
}
