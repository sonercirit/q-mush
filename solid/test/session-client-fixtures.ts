import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function sessionMessage(
  id: string,
  content: string,
  role: "assistant" | "tool",
  toolName: string | null = null,
): AgentSessionDetail["messages"][number] {
  return {
    content,
    createdAt: 2,
    id,
    images: [],
    role,
    toolCallId: toolName === null ? null : `call-${id}`,
    toolCalls: [],
    toolName,
  };
}

export const FORMATTED_SESSION_MESSAGES: AgentSessionDetail["messages"] = [
  sessionMessage(
    "assistant-markdown",
    "## Finished\n\nUpdated **two files** with `bun test`.\n\n```ts\nconst ready = true;\n```\n\n- Tests pass\n- Types pass",
    "assistant",
  ),
  sessionMessage(
    "tool-json",
    '[{"output":"ok","recipient_name":"bash"},{"error":null,"recipient_name":"read"}]',
    "tool",
    "parallel",
  ),
  sessionMessage(
    "assistant-unsafe",
    "<script>alert('unsafe')</script>",
    "assistant",
  ),
];

export function sessionStateWithMessages(
  state: SessionViewState,
  messages: AgentSessionDetail["messages"],
): SessionViewState {
  return {
    ...state,
    detail: { ...TEST_SESSION_DETAIL, messages },
    selectedId: TEST_SESSION_DETAIL.id,
  };
}
