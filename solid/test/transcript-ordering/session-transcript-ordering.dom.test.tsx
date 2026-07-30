import { afterEach, expect, test } from "vitest";
import type { AgentSessionDetail } from "../../../shared/session-model.ts";
import { RenderDebugView } from "../../render-debug.tsx";
import type { SessionController } from "../../session-controller.ts";
import { disposeTestViews } from "../dom-test-helpers.ts";
import { defineElementSize } from "../element-size-test-helpers.ts";
import {
  messageBoundary,
  mountTestTranscript,
  type MountedTestTranscript,
} from "../session-dom-test-helpers.tsx";
import { transcriptMessage } from "../transcript-ordering-fixtures.ts";

const disposals: (() => void)[] = [];

function mountedTranscript(
  messages: AgentSessionDetail["messages"],
  debug?: RenderDebugView,
): MountedTestTranscript {
  return mountTestTranscript(messages, disposals, debug);
}

function clonedBaseMessages(
  messages: AgentSessionDetail["messages"],
  ...appended: AgentSessionDetail["messages"]
): AgentSessionDetail["messages"] {
  return [...messages.map((message) => ({ ...message })), ...appended];
}

function transientBoundary(
  container: ParentNode,
  sessionId: string,
  role: "assistant" | "thinking",
): Element | null {
  return container.querySelector(
    `[data-render-boundary='message:stream:${sessionId}:${role}']`,
  );
}

function transcriptMessageOrder(container: ParentNode): readonly string[] {
  return [...container.querySelectorAll("[data-render-boundary^='message:']")]
    .map((element) => element.getAttribute("data-render-boundary"))
    .filter((boundary): boundary is string => boundary !== null);
}

function expectTranscriptOrder(
  container: ParentNode,
  messageIds: readonly string[],
): void {
  expect(transcriptMessageOrder(container)).toEqual(
    messageIds.map((id) => `message:${id}`),
  );
}

function expectStableStreamBase(
  container: ParentNode,
  stableUser: Element,
  stableAssistant: Element,
): void {
  expect(messageBoundary(container, "user-stable")).toBe(stableUser);
  expect(messageBoundary(container, "assistant-stable")).toBe(stableAssistant);
}

function expectStreamReplaced(
  container: ParentNode,
  detail: AgentSessionDetail,
  stableUser: Element,
  stableAssistant: Element,
  role: "assistant" | "thinking",
  previous?: Element,
): void {
  expectStableStreamBase(container, stableUser, stableAssistant);
  const boundary = transientBoundary(container, detail.id, role);
  if (previous === undefined) {
    expect(boundary).toBeNull();
  } else {
    expect(boundary).not.toBe(previous);
  }
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

function applyTranscriptDelta(
  controller: SessionController,
  detail: AgentSessionDetail,
  content: string,
): void {
  controller.applyDelta({
    content,
    sessionId: detail.id,
    thinking: "",
    type: "session_delta",
  });
}

function codeBlock(container: ParentNode): HTMLElement {
  const code = container.querySelector<HTMLElement>("pre[data-language='ts']");
  if (code === null) throw new TypeError("Missing streamed code block");
  return code;
}

function startNestedCodeStream(
  container: ParentNode,
  controller: SessionController,
  detail: AgentSessionDetail,
  scrollTop: number,
): HTMLElement {
  applyTranscriptDelta(controller, detail, "```ts\nconst first = 1;");
  const code = codeBlock(container);
  defineElementSize(code, 100, 400);
  code.scrollTop = scrollTop;
  code.dispatchEvent(new Event("scroll"));
  return code;
}

function growNestedCodeStream(
  container: ParentNode,
  controller: SessionController,
  detail: AgentSessionDetail,
): HTMLElement {
  applyTranscriptDelta(controller, detail, "\nconst second = 2;");
  const updatedCode = codeBlock(container);
  defineElementSize(updatedCode, 100, 500);
  return updatedCode;
}

function nestedStreamFixture(
  id: string,
  prompt: string,
): {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
} {
  return mountedTranscript([transcriptMessage(id, prompt, "user", 2)]);
}

async function settledGrownCodeStream(
  container: ParentNode,
  controller: SessionController,
  detail: AgentSessionDetail,
): Promise<HTMLElement> {
  const updatedCode = growNestedCodeStream(container, controller, detail);
  await Promise.resolve();
  return updatedCode;
}

function expectMessageBoundariesToRenderOnce(
  debug: RenderDebugView,
  messageIds: readonly string[],
): void {
  for (const key of messageIds) {
    expect(debug.measurement(key).count).toBe(1);
  }
}

afterEach(() => {
  disposeTestViews(disposals);
});

test("keeps a streamed code block at the user's nested scroll position", async () => {
  const { container, controller, detail } = nestedStreamFixture(
    "user-scroll",
    "Show the output",
  );

  const code = startNestedCodeStream(container, controller, detail, 83);
  const updatedCode = await settledGrownCodeStream(
    container,
    controller,
    detail,
  );
  expect(updatedCode).not.toBe(code);
  expect(updatedCode.scrollTop).toBe(83);
});

test("keeps a bottom-pinned nested region following streamed growth", async () => {
  const { container, controller, detail } = nestedStreamFixture(
    "user-pinned",
    "Keep following",
  );
  startNestedCodeStream(container, controller, detail, 300);
  const updatedCode = await settledGrownCodeStream(
    container,
    controller,
    detail,
  );

  expect(updatedCode.scrollTop).toBe(400);
});

test("keeps persisted and streamed turns in canonical DOM order", () => {
  const messages: AgentSessionDetail["messages"] = [
    transcriptMessage("user-earlier", "Earlier request", "user", 1),
    transcriptMessage("assistant-earlier", "Earlier answer", "assistant", 2),
    transcriptMessage("user-current", "Current request", "user", 3),
  ];
  const { container, controller, detail } = mountedTranscript(messages);
  controller.applyDetail(detail);
  const stableUser = messageBoundary(container, "user-earlier");
  const stableAssistant = messageBoundary(container, "assistant-earlier");

  controller.applyDelta({
    content: "Live answer",
    sessionId: detail.id,
    thinking: "Live reasoning",
    type: "session_delta",
  });

  expectTranscriptOrder(container, [
    "user-earlier",
    "assistant-earlier",
    "user-current",
    `stream:${detail.id}:thinking`,
    `stream:${detail.id}:assistant`,
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
      "user-earlier",
      "assistant-earlier",
      "user-current",
      "thinking-current",
      "assistant-current",
    ]);
    expect(messageBoundary(container, "user-earlier")).toBe(stableUser);
    expect(messageBoundary(container, "assistant-earlier")).toBe(
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
  const debug = new RenderDebugView();
  const { container, controller, detail } = mountedTranscript(messages, debug);
  const stableUser = messageBoundary(container, "user-stable");
  const stableAssistant = messageBoundary(container, "assistant-stable");

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
  expectMessageBoundariesToRenderOnce(debug, [
    "message:user-stable",
    "message:assistant-stable",
  ]);
  expect(debug.measurement(`message:stream:${detail.id}:assistant`).count).toBe(
    2,
  );
  const streamedMessage = messageBoundary(
    container,
    `stream:${detail.id}:assistant`,
  );
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
    "user-stable",
    "assistant-stable",
    "thinking-persisted",
    `stream:${detail.id}:assistant`,
  ]);
  expectStreamReplaced(
    container,
    detail,
    stableUser,
    stableAssistant,
    "thinking",
  );

  applyStreamSnapshot(
    controller,
    detail,
    messages,
    persistedThinking,
    persistedAssistant,
  );

  expectStreamReplaced(
    container,
    detail,
    stableUser,
    stableAssistant,
    "assistant",
    streamedMessage,
  );
  expectMessageBoundariesToRenderOnce(debug, [
    "message:user-stable",
    "message:assistant-stable",
    "message:thinking-persisted",
    "message:assistant-persisted",
  ]);
  expect(container.textContent).toContain("Streaming response");
});
