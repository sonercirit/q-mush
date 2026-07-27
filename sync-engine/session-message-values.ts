import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import {
  recordedMessageValues,
  type StoredMessageValues,
} from "./session-store-values.ts";

export function storedRecordedMessages(
  messages: readonly AgentRecordedMessage[],
): readonly StoredMessageValues[] {
  return messages.map(recordedMessageValues);
}
