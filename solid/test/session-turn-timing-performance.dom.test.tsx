import { createSignal } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import {
  mountTestTranscriptView,
  transcriptTestMessage,
} from "./session-dom-test-helpers.tsx";

test("streaming deltas do not revisit completed turns or markdown", () => {
  let historicalTimestampReads = 0;
  const completedMessages = Array.from({ length: 100 }, (_, turn) => {
    const startedAt = (turn + 1) * 2;
    const user = transcriptTestMessage(
      `user-${String(turn)}`,
      "Request",
      "user",
      startedAt,
    );
    Object.defineProperty(user, "createdAt", {
      get: () => {
        historicalTimestampReads += 1;
        return startedAt;
      },
    });
    return [
      user,
      transcriptTestMessage(
        `assistant-${String(turn)}`,
        "Response",
        "assistant",
        startedAt + 1,
      ),
    ];
  }).flat();
  const activeUser = transcriptTestMessage(
    "active-user",
    "Request",
    "user",
    202,
  );
  const initialMessages: readonly AgentSessionMessage[] = [
    ...completedMessages,
    activeUser,
    transcriptTestMessage("stream:session:assistant", "A", "assistant", 203),
  ];
  const [messages, setMessages] =
    createSignal<readonly AgentSessionMessage[]>(initialMessages);
  const { container, dispose } = mountTestTranscriptView({
    messages,
    status: () => "running",
  });
  const initialTimestampReads = historicalTimestampReads;
  const historicalMarkdown = container.querySelector(
    "[data-render-boundary='message:assistant-0'] > div.mt-2 p",
  );
  expect(historicalMarkdown).not.toBeNull();

  for (let delta = 0; delta < 50; delta += 1) {
    setMessages((current) => {
      const streamed = current.at(-1);
      if (streamed === undefined) throw new TypeError("Missing stream message");
      return [
        ...current.slice(0, -1),
        { ...streamed, content: `${streamed.content}.` },
      ];
    });
  }

  expect(historicalTimestampReads).toBe(initialTimestampReads);
  expect(
    container.querySelector(
      "[data-render-boundary='message:assistant-0'] > div.mt-2 p",
    ),
  ).toBe(historicalMarkdown);
  expect(container.querySelectorAll("[data-turn-timing]")).toHaveLength(101);
  dispose();
  container.remove();
});
