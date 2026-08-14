import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import type { SessionStore } from "../session-store.ts";
import { TEST_REPLAY_IDENTITY } from "./session-replay-test-helpers.ts";

export function testConversation(
  store: Pick<SessionStore, "conversation">,
  sessionId: string,
  interrupted = true,
): readonly AgentConversationMessage[] {
  return store.conversation(sessionId, TEST_REPLAY_IDENTITY, interrupted);
}
