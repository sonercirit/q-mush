import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../session-transcript-filters.ts";
import { SessionTranscript } from "../session-transcript.tsx";
import {
  testAssistantToolCall,
  testToolStream,
} from "./session-tool-stream-fixtures.ts";

const disposals: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

test("attaches a live tool stream to its persisted tool call", () => {
  const callId = "call-running";
  const message = testAssistantToolCall(callId, '{"durationMs":1000}', "sleep");
  const stream = testToolStream(callId, '{"durationMs":1000}', "sleep");
  const container = document.body.appendChild(document.createElement("ul"));
  const transcriptProps: Parameters<typeof SessionTranscript>[0] = {
    agentFile: null,
    executionEnvironment: "bare_metal",
    filters: DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    messages: [message],
    toolStreams: [stream],
    tools: [],
  };
  disposals.push(render(() => SessionTranscript(transcriptProps), container));

  const persistedCall = container.querySelector(
    `[data-render-boundary='tool-call:${callId}']`,
  );
  expect(persistedCall?.getAttribute("data-tool-stream-state")).toBe("running");
  expect(persistedCall?.textContent).toContain("Running");
  expect(persistedCall?.textContent).toContain("waiting");
  expect(
    container.querySelector("[data-render-boundary^='tool-stream:']"),
  ).toBeNull();
  expect(
    [...container.querySelectorAll("p")].filter(
      ({ textContent }) => textContent === "Tool call · sleep",
    ),
  ).toHaveLength(1);
});
