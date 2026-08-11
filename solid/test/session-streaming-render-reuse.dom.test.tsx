import { createSignal } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { createDisplaySessionMessage } from "../session-message.ts";
import { mountTestTranscriptView } from "./session-dom-test-helpers.tsx";

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
  const [messages, setMessages] = createSignal(
    streamedMessages(`${paragraphs.join("\n\n")}\n\nGrowing`, "Answer so far"),
  );
  const view = mountTestTranscriptView({ messages, status: () => "running" });
  const container = view.container;
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
  view.dispose();
  container.remove();
});
