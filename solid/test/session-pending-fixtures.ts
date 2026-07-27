import type { AgentSessionPendingInput } from "../../shared/session-model.ts";

export function pendingInputFixture(
  content: string,
  overrides: Partial<AgentSessionPendingInput> = {},
): AgentSessionPendingInput {
  return {
    clientRequestId: `request-${content}`,
    content,
    createdAt: 1,
    id: `pending-${content}`,
    images: [],
    kind: "follow_up",
    ...overrides,
  };
}
