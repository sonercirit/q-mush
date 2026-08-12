import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { SessionController } from "../../solid/session-controller.ts";
import { createDisplaySessionMessage } from "../../solid/session-message.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import {
  sessionDetailWithStatus,
  sessionMessageIds,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";

function unanchoredDeltaController(
  sessionId: string,
  content: string,
  thinking: string,
  messages: AgentSessionDetail["messages"],
): SessionController {
  const reactive = createReactiveState<SessionViewState>(
    initialSessionViewState(),
  );
  const controller = createRoot(() => new SessionController(reactive));
  const delta = { content, sessionId, thinking } as const;
  controller.applyDelta({ ...delta, type: "session_delta" });
  reactive.setState((state) => ({ ...state, selectedId: sessionId }));
  controller.applyDetail(
    sessionDetailWithStatus("running", messages, sessionId),
  );
  return controller;
}

const UNANCHORED_STEP_MESSAGES = [
  transcriptMessage("user-1", "Request", "user", 1),
  transcriptMessage("thinking-1", "Deep analysis", "thinking", 2),
  transcriptMessage("assistant-1", "", "assistant", 3),
] as const;

test.each([
  { messages: [...UNANCHORED_STEP_MESSAGES], name: "step" },
  {
    messages: [
      ...UNANCHORED_STEP_MESSAGES,
      {
        ...createDisplaySessionMessage({
          content: "tool output",
          createdAt: 4,
          id: "tool-1",
          role: "tool",
        }),
        toolCallId: "call-1",
        toolName: "sleep",
      },
    ],
    name: "step ending in a tool result",
  },
])(
  "drops a stale unanchored stream once its $name is already persisted",
  ({ messages }) => {
    const controller = unanchoredDeltaController(
      "session-unseen-delta",
      "",
      "Deep analysis",
      messages,
    );

    expect(sessionMessageIds(controller)).toEqual(messages.map(({ id }) => id));
  },
);

test("drops a stale stream whose buffer holds only a suffix of the step", () => {
  const controller = unanchoredDeltaController(
    "session-partial-buffer",
    "",
    "analysis",
    [...UNANCHORED_STEP_MESSAGES],
  );

  expect(sessionMessageIds(controller)).toEqual(
    UNANCHORED_STEP_MESSAGES.map(({ id }) => id),
  );
});

test("keeps a fresh stream matching an earlier step's assistant text", () => {
  const sessionId = "session-cross-step";
  const controller = unanchoredDeltaController(sessionId, "Done", "", [
    transcriptMessage("user-1", "Request", "user", 1),
    transcriptMessage("assistant-old", "Done", "assistant", 2),
    {
      ...createDisplaySessionMessage({
        content: "tool output",
        createdAt: 3,
        id: "tool-old",
        role: "tool",
      }),
      toolCallId: "call-old",
      toolName: "bash",
    },
    transcriptMessage("thinking-new", "Next step", "thinking", 4),
    transcriptMessage("assistant-new", "", "assistant", 5),
  ]);

  // The final step's assistant is empty, so "Done" only matches the earlier
  // step's text and must not anchor there; the stream stays live at the end.
  expect(sessionMessageIds(controller)).toEqual([
    "user-1",
    "assistant-old",
    "tool-old",
    "thinking-new",
    "assistant-new",
    `stream:${sessionId}:assistant`,
  ]);
});

test.each([
  { buffered: "D", name: "single-character head collision" },
  { buffered: "Deep ", name: "head fragment" },
  { buffered: "analys", name: "interior fragment" },
])(
  "keeps a fresh stream whose $name only starts or splits persisted text",
  ({ buffered }) => {
    const sessionId = "session-partial-collision";
    const controller = unanchoredDeltaController(sessionId, "", buffered, [
      ...UNANCHORED_STEP_MESSAGES,
    ]);

    // Head and interior fragments are weak evidence: a fresh stream's first
    // short delta often prefixes unrelated persisted text, and swallowing a
    // fresh stream loses live output, so the stream must stay live.
    expect(sessionMessageIds(controller)).toEqual([
      ...UNANCHORED_STEP_MESSAGES.map(({ id }) => id),
      `stream:${sessionId}:thinking`,
    ]);
  },
);

test("keeps a fresh unanchored continuation after a prior trailing assistant", () => {
  const sessionId = "session-fresh-continuation";
  const controller = unanchoredDeltaController(
    sessionId,
    "Fresh continuation",
    "",
    [
      transcriptMessage("user-1", "Request", "user", 1),
      transcriptMessage("assistant-old", "Previous answer", "assistant", 2),
    ],
  );

  expect(sessionMessageIds(controller)).toEqual([
    "user-1",
    "assistant-old",
    `stream:${sessionId}:assistant`,
  ]);
});
