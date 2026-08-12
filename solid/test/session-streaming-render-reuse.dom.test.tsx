import { createSignal } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { createDisplaySessionMessage } from "../session-message.ts";
import { mountTestTranscriptView } from "./session-dom-test-helpers.tsx";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

function mountRunningTranscript(initial: readonly AgentSessionMessage[]): {
  readonly container: HTMLUListElement;
  readonly dispose: () => void;
  readonly setMessages: (messages: readonly AgentSessionMessage[]) => void;
} {
  const [messages, setMessages] = createSignal(initial);
  const view = mountTestTranscriptView({ messages, status: () => "running" });
  return { container: view.container, dispose: view.dispose, setMessages };
}

function streamedMessages(
  thinking: string,
  assistant: string,
): readonly AgentSessionMessage[] {
  return [
    createDisplaySessionMessage({
      content: "Request",
      createdAt: 1,
      id: "user-1",
      role: "user",
    }),
    createDisplaySessionMessage({
      content: thinking,
      createdAt: 2,
      id: "stream:session-reuse:thinking",
      role: "thinking",
    }),
    createDisplaySessionMessage({
      content: assistant,
      createdAt: 2,
      id: "stream:session-reuse:assistant",
      role: "assistant",
    }),
  ];
}

test("streamed deltas reuse message shells and settled markdown blocks", () => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, index) => `Settled paragraph ${String(index)} with **bold** text.`,
  );
  const { container, dispose, setMessages } = mountRunningTranscript(
    streamedMessages(`${paragraphs.join("\n\n")}\n\nGrowing`, "Answer so far"),
  );
  const thinkingNote = () =>
    container.querySelector(
      "[data-render-boundary='message:stream:session-reuse:thinking']",
    );
  const initialNote = thinkingNote();
  const initialParagraphs = [...(initialNote?.querySelectorAll("p") ?? [])];
  expect(initialParagraphs.length).toBeGreaterThan(40);

  let retainedShells = 0;
  let retainedFirstParagraphs = 0;
  for (let delta = 0; delta < 25; delta += 1) {
    setMessages(
      streamedMessages(
        `${paragraphs.join("\n\n")}\n\nGrowing${"!".repeat(delta + 1)}`,
        `Answer so far${".".repeat(delta + 1)}`,
      ),
    );
    const note = thinkingNote();
    if (note === initialNote) retainedShells += 1;
    const firstParagraph = note?.querySelectorAll("p")[1];
    if (firstParagraph === initialParagraphs[1]) retainedFirstParagraphs += 1;
  }

  expect(retainedShells).toBe(25);
  expect(retainedFirstParagraphs).toBe(25);
  expect(container.textContent).toContain(`Growing${"!".repeat(25)}`);
  expect(container.textContent).toContain(`Answer so far${".".repeat(25)}`);
  dispose();
  container.remove();
});

test("a settled streamed code block keeps a live wrap toggle across deltas", () => {
  const settled = 'Settled intro.\n\n```ts\nconst value = "kept";\n```';
  const { container, dispose, setMessages } = mountRunningTranscript(
    streamedMessages(`${settled}\n\nGrowing`, "Answer"),
  );
  const toggle = () =>
    container.querySelector<HTMLButtonElement>("[data-subscroll-wrap-toggle]");
  const pane = () => container.querySelector<HTMLElement>("[data-line-wrap]");
  const initialToggle = toggle();
  expect(initialToggle?.getAttribute("aria-pressed")).toBe("true");
  expect(pane()?.dataset["lineWrap"]).toBe("true");

  setMessages(streamedMessages(`${settled}\n\nGrowing more`, "Answer."));
  // The settled code block must retain both its DOM and its reactive owner:
  // a disposed owner leaves a dead button that no longer flips wrap state.
  expect(toggle()).toBe(initialToggle);
  toggle()?.click();
  expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  expect(pane()?.dataset["lineWrap"]).toBe("false");

  setMessages(streamedMessages(`${settled}\n\nGrowing more still`, "Answer.."));
  expect(toggle()).toBe(initialToggle);
  expect(pane()?.dataset["lineWrap"]).toBe("false");
  toggle()?.click();
  expect(pane()?.dataset["lineWrap"]).toBe("true");
  dispose();
  container.remove();
});

test("a retained streamed row follows its recomputed nested scroll key", () => {
  const sessionId = "session-reuse";
  const streamId = `stream:${sessionId}:thinking`;
  const stream = createDisplaySessionMessage({
    content: "Streaming thought",
    createdAt: 5,
    id: streamId,
    role: "thinking",
  });
  const user = transcriptMessage("user-1", "Request", "user", 1);
  const { container, dispose, setMessages } = mountRunningTranscript([
    user,
    stream,
  ]);
  const row = () =>
    container.querySelector(`[data-render-boundary='message:${streamId}']`);
  const scrollHost = () =>
    container.querySelector(
      `[data-nested-scroll-key*=':thinking:'], [data-nested-scroll-key='${streamId}']`,
    );
  const initialRow = row();
  expect(scrollHost()?.getAttribute("data-nested-scroll-key")).toBe(
    "after:user-1:thinking:0",
  );

  // A persisted tool result grows the stable prefix around the live stream:
  // the retained row must re-key its scroll bookkeeping, not keep recording
  // under the stale anchor.
  const tool = {
    ...createDisplaySessionMessage({
      content: "tool output",
      createdAt: 2,
      id: "tool-1",
      role: "tool",
    }),
    toolCallId: "call-1",
    toolName: "bash",
  };
  setMessages([user, tool, stream]);
  expect(row()).toBe(initialRow);
  expect(scrollHost()?.getAttribute("data-nested-scroll-key")).toBe(
    "after:tool-1:thinking:0",
  );
  dispose();
  container.remove();
});
