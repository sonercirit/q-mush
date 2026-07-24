import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";

export const REALTIME_TEST_SESSION_DETAIL: AgentSessionDetail = {
  ...TEST_SESSION_DETAIL,
  currentContextTokens: 0,
  maxContextTokens: null,
  model: "model-1",
  title: "Realtime session",
  tools: [],
  updatedAt: 1,
  workingDirectory: "/work/project",
};
