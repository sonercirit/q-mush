import { afterEach, expect, test } from "vitest";
import type { AgentSessionDetail } from "../../../shared/session-model.ts";
import type { SessionController } from "../../session-controller.ts";
import {
  cleanupTestViews,
  mountTestTranscript,
  queryTestElement,
  type MountedTestTranscript,
} from "../session-dom-test-helpers.tsx";
import { transcriptMessage } from "../transcript-ordering-fixtures.ts";

const disposals: (() => void)[] = [];

function mountedTranscript(
  messages: AgentSessionDetail["messages"],
): MountedTestTranscript {
  return mountTestTranscript(messages, disposals);
}

function clonedBaseMessages(
  messages: AgentSessionDetail["messages"],
  ...appended: AgentSessionDetail["messages"]
): AgentSessionDetail["messages"] {
  return [...messages.map((message) => ({ ...message })), ...appended];
}

function transcriptItems(container: ParentNode): readonly Element[] {
  const transcript = queryTestElement(container, "[data-session-transcript]");
  return [...transcript.children].slice(2);
}

function itemHasLabel(item: Element, label: string): boolean {
  return item.firstElementChild?.textContent.trim() === label;
}

function messageItem(
  container: ParentNode,
  content: string,
  label: "Agent" | "Thinking" | "You" = "You",
): Element {
  const message = transcriptItems(container).find(
    (item) => itemHasLabel(item, label) && item.textContent.includes(content),
  );
  if (message === undefined) {
    throw new Error(`The transcript message ${content} was not rendered`);
  }
  return message;
}

function transientMessage(
  container: ParentNode,
  role: "assistant" | "thinking",
): Element | null {
  const label = role === "assistant" ? "Agent" : "Thinking";
  return (
    transcriptItems(container).find((item) => itemHasLabel(item, label)) ?? null
  );
}

function transcriptMessageOrder(container: ParentNode): readonly string[] {
  return transcriptItems(container).map((item) => item.textContent);
}

function expectTranscriptOrder(
  container: ParentNode,
  messageContents: readonly string[],
): void {
  const order = transcriptMessageOrder(container);
  expect(order).toHaveLength(messageContents.length);
  for (const [index, content] of messageContents.entries()) {
    expect(order[index]).toContain(content);
  }
}

function expectStableStreamBase(
  container: ParentNode,
  stableUser: Element,
  stableAssistant: Element,
): void {
  expect(messageItem(container, "Keep this message stable")).toBe(stableUser);
  expect(messageItem(container, "This one is also complete", "Agent")).toBe(
    stableAssistant,
  );
}

function expectStreamReplaced(
  container: ParentNode,
  stableUser: Element,
  stableAssistant: Element,
  previous: Element,
): void {
  expectStableStreamBase(container, stableUser, stableAssistant);
  expect(transcriptItems(container)).not.toContain(previous);
}

function applyStreamSnapshot(
  controller: SessionController,
  detail: AgentSessionDetail,
  messages: AgentSessionDetail["messages"],
  ...appended: AgentSessionDetail["messages"]
): void {
  controller.applyDetail({
    ...detail,
    messages: clonedBaseMessages(messages, ...appended),
    updatedAt: appended.at(-1)?.createdAt ?? detail.updatedAt,
  });
}

afterEach(cleanupTestViews(disposals));

test("keeps persisted and streamed turns in canonical DOM order", () => {
  const messages: AgentSessionDetail["messages"] = [
    transcriptMessage("user-earlier", "Earlier request", "user", 1),
    transcriptMessage("assistant-earlier", "Earlier answer", "assistant", 2),
    transcriptMessage("user-current", "Current request", "user", 3),
  ];
  const { container, controller, detail } = mountedTranscript(messages);
  controller.applyDetail(detail);
  const stableUser = messageItem(container, "Earlier request");
  const stableAssistant = messageItem(container, "Earlier answer", "Agent");

  controller.applyDelta({
    content: "Live answer",
    sessionId: detail.id,
    thinking: "Live reasoning",
    type: "session_delta",
  });

  expectTranscriptOrder(container, [
    "Earlier request",
    "Earlier answer",
    "Current request",
    "Live reasoning",
    "Live answer",
  ]);

  controller.applyDetail({
    ...detail,
    messages: [
      transcriptMessage("user-current", "Current request", "user", 3),
      transcriptMessage("assistant-earlier", "Earlier answer", "assistant", 2),
      transcriptMessage("thinking-current", "Live reasoning", "thinking", 4),
      transcriptMessage("user-earlier", "Earlier request", "user", 1),
      transcriptMessage("assistant-current", "Live answer", "assistant", 5),
    ],
    status: "idle",
    updatedAt: 5,
  });

  const expectCurrentTranscript = (): void => {
    expectTranscriptOrder(container, [
      "Earlier request",
      "Earlier answer",
      "Current request",
      "Live reasoning",
      "Live answer",
    ]);
    expect(messageItem(container, "Earlier request")).toBe(stableUser);
    expect(messageItem(container, "Earlier answer", "Agent")).toBe(
      stableAssistant,
    );
  };
  expectCurrentTranscript();

  document.dispatchEvent(new Event("visibilitychange"));

  expectCurrentTranscript();
});

test("reconciles a persisted thinking snapshot before its assistant", () => {
  const messages: AgentSessionDetail["messages"] = [
    transcriptMessage("user-stable", "Keep this message stable", "user", 2),
    transcriptMessage(
      "assistant-stable",
      "This one is also complete",
      "assistant",
      3,
    ),
  ];
  const { container, controller, detail } = mountedTranscript(messages);
  const stableUser = messageItem(container, "Keep this message stable");
  const stableAssistant = messageItem(
    container,
    "This one is also complete",
    "Agent",
  );

  controller.applyDelta({
    content: "Streaming",
    sessionId: detail.id,
    thinking: "Streaming",
    type: "session_delta",
  });
  controller.applyDelta({
    content: " response",
    sessionId: detail.id,
    thinking: " thought",
    type: "session_delta",
  });

  expectStableStreamBase(container, stableUser, stableAssistant);
  const streamedThinking = transientMessage(container, "thinking");
  if (streamedThinking === null) {
    throw new Error("The streamed thinking message was not rendered");
  }
  const streamedMessage = messageItem(container, "Streaming response", "Agent");
  const persistedThinking = transcriptMessage(
    "thinking-persisted",
    "Streaming thought",
    "thinking",
    4,
  );
  const persistedAssistant = transcriptMessage(
    "assistant-persisted",
    "Streaming response",
    "assistant",
    5,
  );

  applyStreamSnapshot(controller, detail, messages, persistedThinking);

  expectTranscriptOrder(container, [
    "Keep this message stable",
    "This one is also complete",
    "Streaming thought",
    "Streaming response",
  ]);
  expectStreamReplaced(
    container,
    stableUser,
    stableAssistant,
    streamedThinking,
  );

  applyStreamSnapshot(
    controller,
    detail,
    messages,
    persistedThinking,
    persistedAssistant,
  );

  expectStreamReplaced(container, stableUser, stableAssistant, streamedMessage);
  expectTranscriptOrder(container, [
    "Keep this message stable",
    "This one is also complete",
    "Streaming thought",
    "Streaming response",
  ]);
  expect(container.textContent).toContain("Streaming response");
});
