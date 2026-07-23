import { afterEach, expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { summaryFromDetail } from "../session-codec.ts";
import {
  applyTranscriptDelta,
  DomTestHarness,
  transcriptTestMessage,
} from "./session-dom-test-harness.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const harness = new DomTestHarness();

function transcriptFilter(container: ParentNode): HTMLInputElement {
  const control = harness.query(
    container,
    "input[data-transcript-filter='thinking']",
  );
  if (!(control instanceof HTMLInputElement)) {
    throw new TypeError("The thinking filter is not a checkbox");
  }
  return control;
}

afterEach(() => {
  harness.dispose();
  localStorage.clear();
});

test("the running composer stays mounted and retains its draft when ready again", () => {
  const running: AgentSessionDetail = {
    ...TEST_SESSION_DETAIL,
    messages: [],
    status: "running",
  };
  const { container, controller } = harness.mountSession(running);
  const composer = harness.query(container, "[data-session-composer='true']");
  const prompt = harness.query(composer, "textarea[name='prompt']");
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError("The follow-up prompt is not a textarea");
  }

  expect(prompt.disabled).toBe(true);
  expect(container.textContent).toContain(
    "Session is running. You can send when it is ready.",
  );

  controller.setFollowUp("Keep this unsent draft");
  controller.applyDetail({
    ...running,
    status: "idle",
    updatedAt: running.updatedAt + 1,
  });

  expect(harness.query(container, "[data-session-composer='true']")).toBe(
    composer,
  );
  expect(harness.query(composer, "textarea[name='prompt']")).toBe(prompt);
  expect(prompt.value).toBe("Keep this unsent draft");
  expect(prompt.disabled).toBe(false);
  expect(container.textContent).toContain("Ready for another instruction.");
  expect(container.textContent).toContain("Continue");
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
  const { container, controller } = harness.mountSession(detail);
  const thinking = transcriptFilter(container);

  expect(container.textContent).toContain("Thinking hidden");
  thinking.click();

  expect(thinking.checked).toBe(false);
  expect(container.textContent).not.toContain("Thinking hidden");
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (): Promise<Response> => Promise.resolve(Response.json(second)),
    { preconnect: originalFetch.preconnect },
  );
  harness.disposals.push(() => {
    globalThis.fetch = originalFetch;
  });
  controller.applyRealtime([summaryFromDetail(second)]);
  const selection = controller.select(second.id);
  controller.applyDetail(second);
  void selection;

  expect(container.textContent).not.toContain("Second session thinking");
  expect(container.textContent).toContain("Second session answer");
  expect(
    harness.query(container, "input[data-transcript-filter='thinking']"),
  ).not.toBe(thinking);
  expect(
    localStorage.getItem("q-mush.session-transcript-filters.v1"),
  ).toContain('"thinking":false');
});

test("filtering streamed categories preserves placeholders and canonical order", () => {
  const detail: AgentSessionDetail = {
    ...TEST_SESSION_DETAIL,
    messages: [
      transcriptTestMessage("user-stream", "Prompt before stream", "user", 2),
    ],
    status: "running",
  };
  const { container, controller } = harness.mountSession(detail);
  applyTranscriptDelta(
    controller,
    detail.id,
    "Visible answer",
    "Hidden thought",
  );
  const streamId = `stream:${detail.id}:assistant`;
  const streamedAnswer = harness.messageBoundary(container, streamId);
  const thinking = transcriptFilter(container);

  thinking.click();
  applyTranscriptDelta(controller, detail.id, " continues", " continues");

  expect(container.textContent).not.toContain("Hidden thought");
  expect(container.textContent).toContain("Visible answer continues");
  expect(harness.messageBoundary(container, streamId)).not.toBe(streamedAnswer);
  expect(container.textContent.indexOf("Prompt before stream")).toBeLessThan(
    container.textContent.indexOf("Visible answer continues"),
  );
});
