import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";
import {
  recordedMessageValues,
  type StoredMessageValues,
} from "./session-store-values.ts";

export function storedRecordedMessages(
  messages: readonly AgentRecordedMessage[],
  tokenUsage?: AgentSessionUsageUpdate["tokenUsage"],
): readonly StoredMessageValues[] {
  return messages.map((message) =>
    recordedMessageValues(
      message,
      message.role === "assistant" ? tokenUsage : undefined,
    ),
  );
}
