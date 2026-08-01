import { createSignal } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { createSessionTranscriptCounts } from "../session-transcript-counts.ts";
import { createSessionTranscriptMessageGroups } from "../session-transcript-messages.ts";
import {
  mountTestTranscriptView,
  transcriptTestMessage,
} from "./session-dom-test-helpers.tsx";

test("streaming deltas do not revisit completed steps or markdown", () => {
  let historicalMessageReads = 0;
  let historicalRoleReads = 0;
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
    const assistant = transcriptTestMessage(
      `assistant-${String(turn)}`,
      "Response",
      "assistant",
      startedAt + 1,
    );
    const role = assistant.role;
    Object.defineProperty(assistant, "role", {
      get: () => {
        historicalRoleReads += 1;
        return role;
      },
    });
    return [user, assistant];
  }).flat();
  const activeUser = transcriptTestMessage(
    "active-user",
    "Request",
    "user",
    202,
  );
  const trackedMessages = (
    streamed: AgentSessionMessage,
  ): readonly AgentSessionMessage[] =>
    new Proxy([...completedMessages, activeUser, streamed], {
      get: (target, property, receiver) => {
        if (
          typeof property === "string" &&
          /^\d+$/u.test(property) &&
          Number(property) < completedMessages.length
        ) {
          historicalMessageReads += 1;
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
  const initialMessages = trackedMessages(
    transcriptTestMessage("stream:session:assistant", "A", "assistant", 203),
  );
  const [messages, setMessages] =
    createSignal<readonly AgentSessionMessage[]>(initialMessages);
  const tools: readonly [] = [];
  const counts = createSessionTranscriptCounts(
    () => null,
    messages,
    () => tools,
  );
  const groups = createSessionTranscriptMessageGroups(messages);
  const initialCounts = counts();
  const initialToolCallArguments = initialCounts.toolCallArguments;
  const initialStableMessages = groups().stable;
  const { container, dispose } = mountTestTranscriptView({
    messages,
    status: () => "running",
  });
  const initialHistoricalMessageReads = historicalMessageReads;
  const initialTimestampReads = historicalTimestampReads;
  const initialRoleReads = historicalRoleReads;
  const historicalMarkdown = container.querySelector(
    "[data-render-boundary='message:assistant-0'] > div.mt-2 p",
  );
  expect(historicalMarkdown).not.toBeNull();

  for (let delta = 0; delta < 50; delta += 1) {
    setMessages((current) => {
      const streamed = current.at(-1);
      if (streamed === undefined) throw new TypeError("Missing stream message");
      return trackedMessages({
        ...streamed,
        content: `${streamed.content}.`,
      });
    });
    expect(counts().toolCallArguments).toBe(initialToolCallArguments);
  }

  expect(initialToolCallArguments.size).toBe(0);
  expect(historicalMessageReads).toBe(initialHistoricalMessageReads);
  expect(historicalTimestampReads).toBe(initialTimestampReads);
  expect(historicalRoleReads).toBe(initialRoleReads);
  expect(counts().filterCounts).toEqual(initialCounts.filterCounts);
  expect(groups().stable).toBe(initialStableMessages);
  expect(
    container.querySelector(
      "[data-render-boundary='message:assistant-0'] > div.mt-2 p",
    ),
  ).toBe(historicalMarkdown);
  expect(container.querySelectorAll("[data-step-timing]")).toHaveLength(101);
  dispose();
  container.remove();
});
