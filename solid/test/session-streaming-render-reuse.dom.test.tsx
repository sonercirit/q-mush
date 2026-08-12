import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { MarkdownView } from "../session-markdown.tsx";
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

test("incremental parsing matches a fresh render at every streamed prefix", () => {
  // The CRLF line exercises deltas that split a "\r\n" pair mid-stream:
  // paired with the stride-1 walk it kills boundary mutants like
  // Math.max(lastIndexOf("\n"), lastIndexOf("\r")) + 1, which stride-7 or
  // an LF-only document each let survive.
  const document = [
    "Intro paragraph with **bold** text.",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```ts",
    'const value = "streamed";',
    "```",
    "",
    "- item one\r",
    "- item two",
    "",
    "> closing quote",
  ].join("\n");
  const host = (): HTMLDivElement =>
    window.document.body.appendChild(window.document.createElement("div"));
  const serialized = (element: HTMLElement): string =>
    new XMLSerializer().serializeToString(element);
  const [content, setContent] = createSignal("");
  const incremental = host();
  const disposeIncremental = render(
    () => <MarkdownView content={content()} />,
    incremental,
  );
  for (let end = 1; end <= document.length; end += 1) {
    const prefix = document.slice(0, end);
    setContent(prefix);
    const fresh = host();
    const disposeFresh = render(() => <MarkdownView content={prefix} />, fresh);
    // A retained settled block must render exactly as a from-scratch parse:
    // this kills any unsound retention boundary (for example an off-by-one
    // that freezes a table row that could still change).
    expect(serialized(incremental)).toBe(serialized(fresh));
    disposeFresh();
    fresh.remove();
  }
  disposeIncremental();
  incremental.remove();
});

test("appending after a long settled blank gap does bounded parser work", () => {
  const settled = `# Settled heading\n${"\n".repeat(1000)}First tail`;
  const [content, setContent] = createSignal(settled);
  const host = window.document.body.appendChild(
    window.document.createElement("div"),
  );
  const dispose = render(() => <MarkdownView content={content()} />, host);
  expect(host.textContent).toContain("First tail");

  // Count parser line inspections through String#trim: rescanning the
  // settled blank gap (or re-parsing the settled document) inspects the
  // 1,000 blank lines again and blows the bound, while a resume at the
  // recorded tail block start touches only the growing tail.
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "trim");
  if (descriptor === undefined) throw new TypeError("Missing String#trim");
  let calls = 0;
  Object.defineProperty(String.prototype, "trim", {
    ...descriptor,
    value: function trackedTrim(this: string): string {
      calls += 1;
      return this.replace(/^\s+|\s+$/gu, "");
    },
  });
  try {
    setContent(`${settled} grows`);
  } finally {
    Object.defineProperty(String.prototype, "trim", descriptor);
  }
  expect(host.textContent).toContain("First tail grows");
  expect(calls).toBeLessThan(50);
  dispose();
  host.remove();
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
