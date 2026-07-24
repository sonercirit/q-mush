import type {
  AgentConversationMessage,
  AgentModelTurn,
} from "../../shared/agent-loop.ts";
import {
  readSessionCompactionRealtimeEvent,
  type RealtimeUserPublisher,
  type SessionCompactionRealtimeEvent,
} from "../../shared/compaction-realtime.ts";
import { TEST_AGENT_SESSION_DETAIL } from "../../shared/test/session-fixture.ts";
import {
  createSessionAgentModels,
  type AgentModelFactory,
  type SessionAgentModels,
} from "../session-agent-models.ts";

export const TEST_COMPACTION_CREDENTIAL = {
  accountId: null,
  id: "credential-1",
  isDefault: false,
  label: "Key",
  secret: "secret",
  source: "api_key" as const,
};

export function testCompactionTurn(
  content: string,
  thinking = "",
): AgentModelTurn {
  return {
    content,
    contextTokens: null,
    costUsd: null,
    thinking,
    tokenUsage: null,
    toolCalls: [],
  };
}

export function testCompactedConversation(summary: string) {
  return {
    costUsd: null,
    messages: [{ content: summary, role: "user" as const }],
    summary,
    tokenUsage: null,
  };
}

export function collectCompactionEvent(
  events: SessionCompactionRealtimeEvent[],
  payload: Readonly<Record<string, unknown>>,
): void {
  if (payload["type"] === "session_compaction") {
    events.push(readSessionCompactionRealtimeEvent(payload));
  }
}

export function testSessionAgentModels(options: {
  readonly events?: SessionCompactionRealtimeEvent[];
  readonly factory: AgentModelFactory;
  readonly operationId: string;
  readonly publish?: RealtimeUserPublisher;
}): SessionAgentModels {
  const events = options.events;
  return createSessionAgentModels({
    agentFile: null,
    credential: TEST_COMPACTION_CREDENTIAL,
    detail: TEST_COMPACTION_SESSION,
    factory: options.factory,
    operationId: () => options.operationId,
    realtime:
      events === undefined && options.publish === undefined
        ? undefined
        : {
            publishUser: (userId, payload) => {
              if (events !== undefined) {
                collectCompactionEvent(events, payload);
              }
              options.publish?.(userId, payload);
            },
          },
    userId: "owner-1",
  });
}

export const TEST_COMPACTION_CONVERSATION: readonly AgentConversationMessage[] =
  [{ content: "Original", role: "user" }];

export const TEST_COMPACTION_SESSION = TEST_AGENT_SESSION_DETAIL;
