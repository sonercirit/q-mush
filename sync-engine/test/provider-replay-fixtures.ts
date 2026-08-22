import type {
  AgentConversationMessage,
  AgentProviderReplay,
  AgentToolCall,
} from "../../shared/agent-loop.ts";

type AssistantConversationMessage = Extract<
  AgentConversationMessage,
  { readonly role: "assistant" }
>;

export const TEST_READ_CALL: AgentToolCall = {
  arguments: '{"path":"README.md"}',
  id: "call-1",
  name: "read",
};

export const TEST_PROVIDER_REPLAY: AgentProviderReplay = {
  blocks: [
    {
      signature: "signed-thinking",
      thinking: "I should read the project documentation first.",
      type: "thinking",
    },
    { text: "I will inspect the project.", type: "text" },
    {
      id: TEST_READ_CALL.id,
      input: { path: "README.md" },
      name: TEST_READ_CALL.name,
      type: "tool_use",
    },
  ],
  model: "claude-test",
  protocol: "anthropic",
  provenance: "test-provenance",
};

export const TEST_PROVIDER_REPLAY_ASSISTANT: AssistantConversationMessage = {
  content: "I will inspect the project.",
  providerReplay: TEST_PROVIDER_REPLAY,
  role: "assistant",
  toolCalls: [TEST_READ_CALL],
};
