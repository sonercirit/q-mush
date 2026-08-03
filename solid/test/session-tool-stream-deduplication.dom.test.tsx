import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import type {
  AgentSessionMessage,
  AgentSessionStatus,
} from "../../shared/session-model.ts";
import type { ToolStreamEntry } from "../../shared/tool-stream.ts";
import {
  DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  type SessionTranscriptFilters,
} from "../session-transcript-filters.ts";
import { SessionTranscript } from "../session-transcript.tsx";
import { transcriptTestMessage } from "./session-dom-test-helpers.tsx";
import {
  testAssistantToolCall,
  testToolStream,
} from "./session-tool-stream-fixtures.ts";

const disposals: (() => void)[] = [];

function mountRunningTranscriptView(
  messages: () => readonly AgentSessionMessage[],
  streams: () => readonly ToolStreamEntry[],
  filters: SessionTranscriptFilters = DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  status: AgentSessionStatus = "running",
): {
  readonly container: HTMLUListElement;
  readonly setMessages: (messages: readonly AgentSessionMessage[]) => void;
} {
  const [viewMessages, setMessages] = createSignal(messages());
  const container = document.body.appendChild(document.createElement("ul"));
  disposals.push(
    render(
      () => (
        <SessionTranscript
          agentFile={null}
          executionEnvironment="bare_metal"
          filters={filters}
          messages={viewMessages()}
          status={status}
          toolStreams={streams()}
          tools={[]}
        />
      ),
      container,
    ),
  );
  return { container, setMessages };
}

function userMessage(id: string, createdAt: number): AgentSessionMessage {
  return transcriptTestMessage(id, "Run the tools", "user", createdAt);
}

function testStartedAt(day: number): number {
  return Date.UTC(2026, 7, day, 12, 0, 0);
}

function toolResult(
  id: string,
  callId: string,
  createdAt: number,
): AgentSessionMessage {
  return {
    ...transcriptTestMessage(id, "done", "tool", createdAt),
    toolCallId: callId,
    toolName: "sleep",
  };
}

function queryLiveStreams(container: ParentNode): NodeListOf<Element> {
  return container.querySelectorAll("[data-render-boundary^='tool-stream:']");
}

function liveStreamBoundary(
  container: ParentNode,
  stream: ToolStreamEntry,
): Element | null {
  return container.querySelector(
    `[data-render-boundary='tool-stream:${stream.streamId}:${stream.callId}']`,
  );
}

function follows(left: Node, right: Node): boolean {
  return (
    (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !==
    0
  );
}

function activeStep(container: ParentNode): Element | null {
  return container.querySelector("[data-active-step='running']");
}

function expectActiveTimingLast(container: ParentNode): void {
  const active = activeStep(container);
  const timing = active?.querySelector("[data-step-timing='active']") ?? null;
  expect(timing).not.toBeNull();
  const preceding = timing?.parentElement?.previousElementSibling;
  if (preceding !== null && preceding !== undefined && timing !== null) {
    expect(follows(preceding, timing)).toBe(true);
  }
}

function expectSingleSleepCall(container: ParentNode): void {
  const labels = [...container.querySelectorAll("p")].filter((paragraph) =>
    paragraph.textContent.endsWith("sleep"),
  );
  expect(labels).toHaveLength(1);
}

function expectNoActiveShell(container: ParentNode): void {
  expect(activeStep(container)).toBeNull();
}

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

test("attaches a live tool stream to its persisted tool call", () => {
  const callId = "call-running";
  const message = testAssistantToolCall(
    callId,
    '{"durationSeconds":1}',
    "sleep",
  );
  const stream = testToolStream(callId, '{"durationSeconds":1}', "sleep");
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
  expectSingleSleepCall(container);
});

test("renders parallel unlanded tool streams inside the output-free active agent block", () => {
  const startedAt = testStartedAt(2);
  const streams = [
    testToolStream("parallel-one", '{"durationSeconds":1}', "sleep", {
      index: 0,
      streamId: "parallel-step",
    }),
    testToolStream("parallel-two", '{"durationSeconds":2}', "sleep", {
      index: 1,
      streamId: "parallel-step",
    }),
  ];
  const { container } = mountRunningTranscriptView(
    () => [userMessage("parallel-user", startedAt)],
    () => streams,
  );

  const active = activeStep(container);
  expect(active?.textContent).toContain("AgentRunning");
  for (const stream of streams) {
    const boundary = liveStreamBoundary(container, stream);
    expect(boundary?.closest("[data-active-step='running']")).toBe(active);
    expect(boundary).not.toBeNull();
  }
  expectActiveTimingLast(container);
  expect(queryLiveStreams(container)).toHaveLength(2);
});

test("orders active content, live tool activity, and duration within one active step", () => {
  const startedAt = testStartedAt(3);
  const streamed = transcriptTestMessage(
    "stream:session-1:assistant",
    "Streaming response",
    "assistant",
    startedAt + 1_000,
  );
  const streams = [
    testToolStream("streamed-call", '{"prompt":"work"}', "spawn_session", {
      index: 0,
      streamId: "streamed-step",
    }),
    testToolStream("streamed-call-two", '{"path":"README.md"}', "read", {
      index: 1,
      streamId: "streamed-step",
    }),
  ];
  const { container } = mountRunningTranscriptView(
    () => [userMessage("streamed-user", startedAt), streamed],
    () => streams,
  );

  const active = activeStep(container);
  const content = container.querySelector(
    "[data-render-boundary='message:stream:session-1:assistant']",
  );
  const activities = streams.map((stream) =>
    liveStreamBoundary(container, stream),
  );
  const timing = active?.querySelector("[data-step-timing='active']") ?? null;
  expect(content?.closest("[data-active-step='running']")).toBe(active);
  for (const activity of activities) {
    expect(activity?.closest("[data-render-boundary^='message:stream:']")).toBe(
      content,
    );
  }
  expect(content).not.toBeNull();
  expect(activities.every((activity) => activity !== null)).toBe(true);
  expect(timing).not.toBeNull();
  const firstActivity = activities[0];
  const lastActivity = activities.at(-1);
  if (
    content !== null &&
    firstActivity !== null &&
    firstActivity !== undefined &&
    lastActivity !== null &&
    lastActivity !== undefined &&
    timing !== null
  ) {
    expect(follows(content, firstActivity)).toBe(true);
    expect(follows(lastActivity, timing)).toBe(true);
  }
});

test("lands live activity in its agent message without an empty running shell", () => {
  const startedAt = testStartedAt(4);
  const stream = testToolStream(
    "landing-call",
    '{"durationSeconds":1}',
    "sleep",
    { streamId: "landing-step" },
  );
  const initialMessages = Array.of(
    userMessage("landing-user", startedAt),
    transcriptTestMessage(
      "stream:session-1:assistant",
      "Preparing the call",
      "assistant",
      startedAt + 1_000,
    ),
  );
  const { container, setMessages } = mountRunningTranscriptView(
    () => initialMessages,
    () => [stream],
  );

  expect(
    liveStreamBoundary(container, stream)?.closest(
      "[data-active-step='running']",
    ),
  ).not.toBeNull();

  const landed = testAssistantToolCall(
    stream.callId,
    stream.arguments,
    stream.name,
    { createdAt: startedAt + 2_000, id: "landed-assistant" },
  );
  const settledMessages = Array.of(
    userMessage("landing-user", startedAt),
    landed,
  );
  setMessages(settledMessages);

  const agentMessage = container.querySelector(
    "[data-render-boundary='message:landed-assistant']",
  );
  const persistedCall = container.querySelector(
    `[data-render-boundary='tool-call:${stream.callId}']`,
  );
  const activeTiming = container.querySelector("[data-step-timing='active']");
  expect(
    persistedCall?.closest("[data-render-boundary='message:landed-assistant']"),
  ).toBe(agentMessage);
  expect(persistedCall?.getAttribute("data-tool-stream-state")).toBe("running");
  expectNoActiveShell(container);
  expect(queryLiveStreams(container)).toHaveLength(0);
  expect(activeTiming).not.toBeNull();
  if (agentMessage !== null && activeTiming !== null) {
    expect(follows(agentMessage, activeTiming)).toBe(true);
  }
  expectSingleSleepCall(container);

  setMessages([userMessage("landing-user", startedAt), landed]);
  const settledContainer = mountRunningTranscriptView(
    () => settledMessages,
    () => [stream],
    DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    "idle",
  ).container;
  expect(
    settledContainer.querySelector(
      `[data-render-boundary='tool-call:${stream.callId}']`,
    ),
  ).not.toBeNull();
  expectNoActiveShell(settledContainer);
  expect(queryLiveStreams(settledContainer)).toHaveLength(0);
});

test("keeps unlanded activity hidden when the tool filter is disabled", () => {
  const startedAt = testStartedAt(5);
  const stream = testToolStream("filtered-call", "{}", "read", {
    streamId: "filtered-step",
  });
  const { container } = mountRunningTranscriptView(
    () => [userMessage("filtered-user", startedAt)],
    () => [stream],
    { ...DEFAULT_SESSION_TRANSCRIPT_FILTERS, toolActivity: false },
  );

  expect(liveStreamBoundary(container, stream)).toBeNull();
  expectNoActiveShell(container);
  expect(container.querySelector("[data-step-timing='active']")).not.toBeNull();
});

test("keeps the next step's tool stream out of the prior agent block", () => {
  const startedAt = testStartedAt(6);
  const priorCall = testAssistantToolCall(
    "prior-call",
    '{"durationSeconds":1}',
    "sleep",
    { createdAt: startedAt + 1_000, id: "prior-assistant" },
  );
  const nextStream = testToolStream(
    "next-call",
    '{"durationSeconds":2}',
    "sleep",
    { streamId: "next-step" },
  );
  const { container } = mountRunningTranscriptView(
    () => [
      userMessage("boundary-user", startedAt),
      priorCall,
      toolResult(
        "prior-result",
        priorCall.toolCalls[0]?.id ?? "",
        startedAt + 2_000,
      ),
    ],
    () => [nextStream],
  );

  const priorAgent = container.querySelector(
    "[data-render-boundary='message:prior-assistant']",
  );
  const active = activeStep(container);
  const activity = liveStreamBoundary(container, nextStream);
  expect(priorAgent?.contains(activity)).toBe(false);
  expect(activity?.closest("[data-active-step='running']")).toBe(active);
  expect(active).not.toBeNull();
});
