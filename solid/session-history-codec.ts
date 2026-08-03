import { readAgentToolCalls } from "../shared/agent-loop.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { SessionHistoryPage } from "../shared/session-history.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import {
  readNonNegativeSafeInteger,
  readNullableString,
} from "../shared/validation.ts";
import { decodedSessionMessage } from "./session-message-decoder.ts";
import { readTokenUsageSummary } from "./session-usage-codec.ts";

function sessionMessage(value: unknown): AgentSessionMessage {
  const invalidMessage = "The server returned an invalid session history page";
  const { fields, record, role } = decodedSessionMessage(value, invalidMessage);
  if (!Array.isArray(record["toolCalls"])) {
    throw new Error("The server returned an invalid session history page");
  }
  return {
    ...fields,
    role,
    toolCalls: readAgentToolCalls(
      record["toolCalls"],
      "The server returned an invalid session history tool call",
    ),
  };
}

export function readSessionHistoryPage(value: unknown): SessionHistoryPage {
  if (!isRecord(value) || !Array.isArray(value["messages"])) {
    throw new Error("The server returned an invalid session history page");
  }
  const currentSegment = readNonNegativeSafeInteger(value["currentSegment"]);
  const segment = readNonNegativeSafeInteger(value["segment"]);
  const newerCursor = readNullableString(value["newerCursor"]);
  const olderCursor = readNullableString(value["olderCursor"]);
  const tokenUsage = readTokenUsageSummary(value["tokenUsage"]);
  if (
    currentSegment === undefined ||
    segment === undefined ||
    segment >= currentSegment ||
    typeof value["sessionId"] !== "string" ||
    newerCursor === undefined ||
    olderCursor === undefined ||
    tokenUsage === undefined
  ) {
    throw new Error("The server returned an invalid session history page");
  }
  return {
    currentSegment,
    messages: value["messages"].map(sessionMessage),
    newerCursor,
    olderCursor,
    segment,
    sessionId: value["sessionId"],
    ...(tokenUsage === null ? {} : { tokenUsage }),
  };
}
