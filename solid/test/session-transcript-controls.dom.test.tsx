import { afterEach, expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { summaryFromDetail } from "../session-codec.ts";
import { MemoryStorage } from "./memory-storage.ts";
import {
  applyTranscriptDelta,
  disposeTestViews,
  DOM_TEST_DISPOSALS,
  messageBoundary,
  mountTestSessionDetail,
  queryTestElement,
  transcriptTestMessage,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const filterStorage = new MemoryStorage();
const FOLLOW_UP_DRAFT = "Keep focus and selection";
const MIXED_ASSISTANT_TEXT = "Assistant text with a tool";
const MIXED_TOOL_TEXT = "Tool call · read";

function expectComposerPreserved(
  container: ParentNode,
  composer: Element,
  prompt: HTMLTextAreaElement,
): void {
  expect(queryTestElement(container, "[data-session-composer='true']")).toBe(
    composer,
  );
  expect(queryTestElement(composer, "textarea[name='prompt']")).toBe(prompt);
  expect(prompt.value).toBe(FOLLOW_UP_DRAFT);
}

function expectPromptAvailability(
  prompt: HTMLTextAreaElement,
  available: boolean,
): void {
  expect(prompt.getAttribute("aria-disabled")).toBe(String(!available));
  expect(prompt.disabled).toBe(false);
  expect(prompt.readOnly).toBe(!available);
}

function expectPromptFocusAndSelection(prompt: HTMLTextAreaElement): void {
  expect(document.activeElement).toBe(prompt);
  expect(prompt.selectionStart).toBe(4);
  expect(prompt.selectionEnd).toBe(9);
}

function expectMixedAssistantVisibility(
  container: ParentNode,
  assistantVisible: boolean,
  toolVisible: boolean,
): void {
  const text = container.textContent ?? "";
  expect(text.includes(MIXED_ASSISTANT_TEXT)).toBe(assistantVisible);
  expect(text.includes(MIXED_TOOL_TEXT)).toBe(toolVisible);
}

function expectThinkingHidden(
  container: ParentNode,
  thinking: HTMLInputElement,
  content: string,
): void {
  expect(thinking.checked).toBe(false);
  expect(container.textContent).not.toContain(content);
}

function transcriptFilter(container: ParentNode): HTMLInputElement {
  const control = queryTestElement(
    container,
    "input[data-transcript-filter='thinking']",
  );
  if (!(control instanceof HTMLInputElement)) {
    throw new TypeError("The thinking filter is not a checkbox");
  }
  return control;
}

afterEach(() => {
  disposeTestViews();
  filterStorage.clear();
});

test("the composer stays mounted and retains focus through a busy transition", () => {
  const idle: AgentSessionDetail = {
    ...TEST_SESSION_DETAIL,
    messages: [],
  };
  const { container, controller } = mountTestSessionDetail(idle);
  const composer = queryTestElement(
    container,
    "[data-session-composer='true']",
  );
  const prompt = queryTestElement(composer, "textarea[name='prompt']");
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError("The follow-up prompt is not a textarea");
  }

  expectPromptAvailability(prompt, true);
  controller.setFollowUp(FOLLOW_UP_DRAFT);
  prompt.focus();
  prompt.setSelectionRange(4, 9);

  const running: AgentSessionDetail = {
    ...idle,
    status: "running",
    updatedAt: idle.updatedAt + 1,
  };
  controller.applyDetail(running);

  expectComposerPreserved(container, composer, prompt);
  expectPromptFocusAndSelection(prompt);
  expectPromptAvailability(prompt, false);
  expect(container.textContent).toContain(
    "Session is running. You can send when it is ready.",
  );

  controller.applyDelta({
    content: "Live output",
    sessionId: running.id,
    thinking: "",
    type: "session_delta",
  });
  expectPromptFocusAndSelection(prompt);

  controller.applyDetail({
    ...idle,
    status: "idle",
    updatedAt: running.updatedAt + 1,
  });

  expectComposerPreserved(container, composer, prompt);
  expectPromptAvailability(prompt, true);
  expect(container.textContent).toContain("Ready for another instruction.");
  expect(container.textContent).toContain("Continue without message");
});

test("transcript filters persist, apply across sessions, and keep visible order", () => {
  const messages: AgentSessionDetail["messages"] = [
    transcriptTestMessage("user-filter", "User first", "user", 2),
    transcriptTestMessage("thinking-filter", "Thinking hidden", "thinking", 3),
    transcriptTestMessage(
      "assistant-filter",
      "Assistant second",
      "assistant",
      4,
    ),
  ];
  const detail = { ...TEST_SESSION_DETAIL, messages };
  const selected: { detail: AgentSessionDetail | undefined } = {
    detail: undefined,
  };
  const transport = {
    command: (operation: string): Promise<unknown> =>
      operation === SESSION_REALTIME_OPERATIONS.read
        ? Promise.resolve({ session: selected.detail })
        : Promise.reject(new Error("Unexpected session command")),
  };
  const { container, controller } = mountTestSessionDetail(
    detail,
    DOM_TEST_DISPOSALS,
    filterStorage,
    transport,
  );
  controller.setTranscriptFilter("thinking", true);
  const thinking = transcriptFilter(container);

  expect(container.textContent).toContain("Thinking hidden");
  thinking.click();

  expectThinkingHidden(container, thinking, "Thinking hidden");
  expect(container.textContent.indexOf("User first")).toBeLessThan(
    container.textContent.indexOf("Assistant second"),
  );

  const thinkingMessage = messages[1];
  const assistantMessage = messages[2];
  if (thinkingMessage === undefined || assistantMessage === undefined) {
    throw new Error("The transcript filter messages are missing");
  }
  const second: AgentSessionDetail = {
    ...detail,
    id: "session-filter-2",
    messages: [
      { ...thinkingMessage, content: "Second session thinking" },
      { ...assistantMessage, content: "Second session answer" },
    ],
    title: "Second session",
  };
  selected.detail = second;
  controller.applyRealtime([summaryFromDetail(second)]);
  const selection = controller.select(second.id);
  controller.applyDetail(second);
  void selection;

  expect(container.textContent).not.toContain("Second session thinking");
  expect(container.textContent).toContain("Second session answer");
  expect(
    queryTestElement(container, "input[data-transcript-filter='thinking']"),
  ).not.toBe(thinking);
  expect(
    filterStorage.getItem("q-mush.session-transcript-filters.v1"),
  ).toContain('"thinking":false');
});

test("assistant text and tool calls react to independent filters", () => {
  const assistant: AgentSessionDetail["messages"][number] = {
    ...transcriptTestMessage(
      "assistant-mixed",
      MIXED_ASSISTANT_TEXT,
      "assistant",
      2,
    ),
    toolCalls: [
      {
        arguments: '{"path":"README.md"}',
        id: "read-mixed",
        name: "read",
      },
    ],
  };
  const { container, controller } = mountTestSessionDetail({
    ...TEST_SESSION_DETAIL,
    messages: [assistant],
  });

  expectMixedAssistantVisibility(container, true, true);

  controller.setTranscriptFilter("assistantMessages", false);
  expectMixedAssistantVisibility(container, false, true);

  controller.setTranscriptFilter("assistantMessages", true);
  controller.setTranscriptFilter("toolActivity", false);
  expectMixedAssistantVisibility(container, true, false);

  controller.setTranscriptFilter("assistantMessages", false);
  expectMixedAssistantVisibility(container, false, false);
});

test("filtering streamed categories preserves placeholders and canonical order", () => {
  const detail: AgentSessionDetail = {
    ...TEST_SESSION_DETAIL,
    messages: [
      transcriptTestMessage("user-stream", "Prompt before stream", "user", 2),
    ],
    status: "running",
  };
  const { container, controller } = mountTestSessionDetail(detail);
  applyTranscriptDelta(
    controller,
    detail.id,
    "Visible answer",
    "Hidden thought",
  );
  const streamId = `stream:${detail.id}:assistant`;
  const streamedAnswer = messageBoundary(container, streamId);
  const thinking = transcriptFilter(container);

  thinking.click();
  expectThinkingHidden(container, thinking, "Hidden thought");
  applyTranscriptDelta(controller, detail.id, " continues", " continues");
  expect(container.textContent).toContain("Visible answer continues");
  expect(messageBoundary(container, streamId)).not.toBe(streamedAnswer);
  expect(container.textContent.indexOf("Prompt before stream")).toBeLessThan(
    container.textContent.indexOf("Visible answer continues"),
  );
});
