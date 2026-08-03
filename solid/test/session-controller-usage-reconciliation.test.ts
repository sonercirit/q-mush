import { expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { summaryFromDetail } from "../../solid/session-codec.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

const TOKEN_USAGE = {
  cacheWriteInputTokens: 0,
  cachedInputTokens: 30,
  inputTokens: 100,
  outputTokens: 20,
} as const;

test("replaces a retained message when its persisted usage changes", () => {
  const message = transcriptMessage(
    "assistant-usage",
    "Response",
    "assistant",
    2,
  );
  const detail: AgentSessionDetail = {
    ...TEST_SESSION_DETAIL,
    messages: [message],
    status: "running",
  };
  const state: SessionViewState = {
    ...initialSessionViewState(),
    detail,
    selectedId: detail.id,
    sessions: [summaryFromDetail(detail)],
  };
  const controller = new SessionController(createReactiveState(state));
  const withUsage = { ...message, tokenUsage: TOKEN_USAGE };

  controller.applyDetail({ ...detail, messages: [withUsage] });

  expect(controller.state.detail?.messages[0]).toBe(withUsage);
});
