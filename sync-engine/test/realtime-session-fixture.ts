import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import type { SessionRealtimeCommands } from "../session-realtime-commands.ts";

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

export function emptyTestModelCatalog() {
  return Promise.resolve({ defaultModel: null, models: [] });
}

export function realtimeTestHistoryPage(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    currentSegment: 0,
    messages: [],
    newerCursor: null,
    olderCursor: null,
    segment: 0,
    sessionId: REALTIME_TEST_SESSION_DETAIL.id,
    ...overrides,
  };
}

export function realtimeTestSessionCommands(
  overrides: Partial<SessionRealtimeCommands> = {},
): SessionRealtimeCommands {
  return {
    answerQuestionsForUser: () => Promise.resolve(undefined),
    compactForUser: () => Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    continueForUser: () => Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    createForUser: () => Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    historyForUser: () => undefined,
    messageForUser: () => Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    modelsForUser: emptyTestModelCatalog,
    pendingInputForUser: () => REALTIME_TEST_SESSION_DETAIL,
    previewToolUpdateForUser: () =>
      Promise.resolve({
        cacheDisposition: "preserved",
        currentGeneration: 0,
        tools: REALTIME_TEST_SESSION_DETAIL.tools,
        warning: null,
      }),
    detailForUser: () => REALTIME_TEST_SESSION_DETAIL,
    reassignForUser: () => REALTIME_TEST_SESSION_DETAIL,
    setAutoCompactionForUser: () => REALTIME_TEST_SESSION_DETAIL,
    stopForUser: () => REALTIME_TEST_SESSION_DETAIL,
    summariesForUser: () => [REALTIME_TEST_SESSION_DETAIL],
    updateToolsForUser: () => Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    ...overrides,
  };
}
