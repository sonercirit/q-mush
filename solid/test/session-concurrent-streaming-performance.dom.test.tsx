import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import type { AgentSessionSummary } from "../../shared/session-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import type { ToolStreamEntry } from "../../shared/tool-stream.ts";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { SessionList } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../session-transcript-filters.ts";
import { SessionTranscript } from "../session-transcript.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

function mountSessionList(sessions: readonly AgentSessionSummary[]): {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
} {
  const state: SessionViewState = {
    ...initialSessionViewState(),
    sessions,
  };
  const controller = new SessionController(createReactiveState(state));
  const container = document.body.appendChild(document.createElement("div"));
  disposals.push(
    render(() => <SessionList controller={controller} />, container),
  );
  return { container, controller };
}

function visibleSessionNodes(
  container: ParentNode,
): ReadonlyMap<string, Element> {
  return new Map(
    [...container.querySelectorAll("[data-session-id]")].map((element) => [
      element.getAttribute("data-session-id") ?? "",
      element,
    ]),
  );
}

function sessionSummaries(count: number): readonly AgentSessionSummary[] {
  const base = summaryFromDetail(TEST_SESSION_DETAIL);
  return Array.from({ length: count }, (_, index) => ({
    ...base,
    id: `session-${String(index)}`,
    title: `Session ${String(index)}`,
    updatedAt: count - index,
  }));
}

function updatedSummary(session: AgentSessionSummary): AgentSessionSummary {
  return {
    ...session,
    currentContextTokens: session.currentContextTokens + 1,
    status: session.status === "running" ? "idle" : "running",
    updatedAt: session.updatedAt + 1,
  };
}

function toolStream(index: number, stdout: string): ToolStreamEntry {
  return {
    arguments: "{}",
    callId: `call-${String(index)}`,
    index,
    name: "read",
    sequence: 1,
    sessionId: "session-streaming",
    state: "running",
    stderr: "",
    stdout,
    streamId: "streaming-turn",
  };
}

function trackedStream(
  stream: ToolStreamEntry,
  onStdoutRead: () => void,
): ToolStreamEntry {
  const stdout = stream.stdout;
  const tracked = { ...stream };
  const descriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: true,
    get() {
      onStdoutRead();
      return stdout;
    },
  };
  Reflect.defineProperty(tracked, "stdout", descriptor);
  return tracked;
}

afterEach(() => {
  while (disposals.length > 0) disposals.pop()?.();
  document.body.replaceChildren();
});

test("many session summary patches replace only the changed visible row", () => {
  let sessions = sessionSummaries(50);
  const { container, controller } = mountSessionList(sessions);
  let previous = visibleSessionNodes(container);
  let retainedRows = 0;
  let replacedRows = 0;

  for (let update = 0; update < 40; update += 1) {
    const changedIndex = update % 10;
    sessions = sessions.map((session, index) =>
      index === changedIndex ? updatedSummary(session) : session,
    );
    controller.applyRealtime(sessions);
    const current = visibleSessionNodes(container);
    for (const [id, node] of current) {
      if (node === previous.get(id)) retainedRows += 1;
      else replacedRows += 1;
    }
    previous = current;
  }

  expect(container.querySelectorAll("[data-session-id]")).toHaveLength(10);
  expect(replacedRows).toBe(40);
  expect(retainedRows).toBe(360);
});

test("a tool delta reads and replaces only its own concurrent stream", () => {
  const largeJson = `{"output":"${"x".repeat(64_000)}`;
  let stdoutReads = 0;
  const outputs = Array.from({ length: 6 }, () => largeJson);
  const initial = outputs.map((stdout, index) => {
    const stream = toolStream(index, stdout);
    return trackedStream(stream, () => {
      stdoutReads += 1;
    });
  });
  const [streams, setStreams] = createSignal(initial);
  const container = document.createElement("ul");
  document.body.append(container);
  const transcriptProps: Omit<
    Parameters<typeof SessionTranscript>[0],
    "toolStreams"
  > = {
    agentFile: null,
    executionEnvironment: "bare_metal",
    filters: DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    messages: [
      {
        content: "",
        createdAt: 1,
        id: "stream:performance:assistant",
        images: [],
        role: "assistant",
        toolCallId: null,
        toolCalls: [],
        toolName: null,
      },
    ],
    status: "running",
    turns: [
      {
        boundaryMessageId: null,
        endedAt: null,
        executionGeneration: 0,
        id: "streaming-turn",
        startedAt: 1,
        toolSettings: DEFAULT_TOOL_SETTINGS,
      },
    ],
    tools: [],
  };
  disposals.push(
    render(
      () => <SessionTranscript {...transcriptProps} toolStreams={streams()} />,
      container,
    ),
  );
  let previous = [
    ...container.querySelectorAll("[data-render-boundary^='tool-stream:']"),
  ];
  stdoutReads = 0;
  let retainedStreams = 0;
  let replacedStreams = 0;

  for (let delta = 0; delta < 30; delta += 1) {
    const changedIndex = delta % initial.length;
    outputs[changedIndex] = `${outputs[changedIndex] ?? ""}x`;
    setStreams((current) =>
      current.map((stream, index) =>
        index === changedIndex
          ? trackedStream(
              {
                ...toolStream(index, outputs[index] ?? ""),
                sequence: stream.sequence + 1,
              },
              () => {
                stdoutReads += 1;
              },
            )
          : stream,
      ),
    );
    const next = [
      ...container.querySelectorAll("[data-render-boundary^='tool-stream:']"),
    ];
    for (const [index, node] of next.entries()) {
      if (node === previous[index]) retainedStreams += 1;
      else replacedStreams += 1;
    }
    previous = next;
  }

  expect(stdoutReads).toBe(30);
  expect(replacedStreams).toBe(30);
  expect(retainedStreams).toBe(150);
  expect(container.textContent).toContain(outputs[5]?.slice(-32));
});
