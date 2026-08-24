import { afterEach, expect, test } from "vitest";
import type { AgentSessionDetail } from "../../../shared/session-model.ts";
import { createRenderDebugView, type RenderDebugView } from "../../render-debug.tsx";
import type { SessionController } from "../../session-controller.ts";
import { disposeTestViews } from "../dom-test-helpers.ts";
import {
  defineElementSize,
  defineElementWidth,
} from "../element-size-test-helpers.ts";
import { applySessionDelta } from "../session-controller-stream-test-helper.ts";
import {
  messageBoundary,
  mountTestTranscript,
  type MountedTestTranscript,
} from "../session-dom-test-helpers.tsx";
import { transcriptMessage } from "../transcript-ordering-fixtures.ts";

const disposals: (() => void)[] = [];

function mountedTranscript(
  messages: AgentSessionDetail["messages"],
  debug?: RenderDebugView,
): MountedTestTranscript {
  return mountTestTranscript(messages, disposals, debug);
}

function clonedBaseMessages(
  messages: AgentSessionDetail["messages"],
  ...appended: AgentSessionDetail["messages"]
): AgentSessionDetail["messages"] {
  return [...messages.map((message) => ({ ...message })), ...appended];
}

function transientBoundary(
  container: ParentNode,
  sessionId: string,
  role: "assistant" | "thinking",
): Element | null {
  return container.querySelector(
    `[data-render-boundary='message:stream:${sessionId}:${role}']`,
  );
}

function transcriptMessageOrder(container: ParentNode): readonly string[] {
  return [...container.querySelectorAll("[data-render-boundary^='message:']")]
    .map((element) => element.getAttribute("data-render-boundary"))
    .filter((boundary): boundary is string => boundary !== null);
}

function expectTranscriptOrder(
  container: ParentNode,
  messageIds: readonly string[],
): void {
  expect(transcriptMessageOrder(container)).toEqual(
    messageIds.map((id) => `message:${id}`),
  );
}

function expectStableStreamBase(
  container: ParentNode,
  stableUser: Element,
  stableAssistant: Element,
): void {
  expect(messageBoundary(container, "user-stable")).toBe(stableUser);
  expect(messageBoundary(container, "assistant-stable")).toBe(stableAssistant);
}

function expectStreamReplaced(
  container: ParentNode,
  detail: AgentSessionDetail,
  stableUser: Element,
  stableAssistant: Element,
  role: "assistant" | "thinking",
  previous?: Element,
): void {
  expectStableStreamBase(container, stableUser, stableAssistant);
  const boundary = transientBoundary(container, detail.id, role);
  if (previous === undefined) {
    expect(boundary).toBeNull();
  } else {
    expect(boundary).not.toBe(previous);
  }
}

function applyStreamSnapshot(
  controller: SessionController,
  detail: AgentSessionDetail,
  messages: AgentSessionDetail["messages"],
  ...appended: AgentSessionDetail["messages"]
): void {
  controller.applyDetail({
    ...detail,
    messages: clonedBaseMessages(messages, ...appended),
    updatedAt: appended.at(-1)?.createdAt ?? detail.updatedAt,
  });
}

function applyTranscriptDelta(
  controller: SessionController,
  detail: AgentSessionDetail,
  content: string,
): void {
  applySessionDelta(controller, {
    content,
    sessionId: detail.id,
    thinking: "",
    type: "session_delta",
  });
}

function codeBlock(container: ParentNode): HTMLElement {
  const code = container.querySelector<HTMLElement>("pre[data-language='ts']");
  if (code === null) throw new TypeError("Missing streamed code block");
  return code;
}

function startNestedCodeStream(
  container: ParentNode,
  controller: SessionController,
  detail: AgentSessionDetail,
  scrollTop: number,
): HTMLElement {
  applyTranscriptDelta(controller, detail, "```ts\nconst first = 1;");
  const code = codeBlock(container);
  defineElementSize(code, 100, 400);
  code.scrollTop = scrollTop;
  code.dispatchEvent(new Event("scroll"));
  return code;
}

type NestedStreamKind = "code" | "table";

interface NestedStreamFixture {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
}

function growNestedStream(
  { container, controller, detail }: NestedStreamFixture,
  kind: NestedStreamKind,
): HTMLElement {
  if (kind === "code") {
    applyTranscriptDelta(controller, detail, "\nconst second = 2;");
    const updatedCode = codeBlock(container);
    defineElementSize(updatedCode, 100, 500);
    return updatedCode;
  }

  applyTranscriptDelta(controller, detail, "\n| another | wider |");
  const updatedTable = nestedTable(container);
  defineElementWidth(updatedTable, 100, 500);
  return updatedTable;
}

async function settledNestedStream(
  fixture: NestedStreamFixture,
  kind: NestedStreamKind,
): Promise<HTMLElement> {
  const updatedElement = growNestedStream(fixture, kind);
  await Promise.resolve();
  return updatedElement;
}

function nestedTable(container: ParentNode): HTMLElement {
  const table = container.querySelector<HTMLElement>(".overflow-x-auto");
  if (table === null) throw new TypeError("Missing streamed table");
  return table;
}

function startNestedTableStream(
  container: ParentNode,
  controller: SessionController,
  detail: AgentSessionDetail,
  scrollLeft: number,
): HTMLElement {
  applyTranscriptDelta(
    controller,
    detail,
    "| First | Second |\n| --- | --- |\n| value | wide |",
  );
  const table = nestedTable(container);
  defineElementWidth(table, 100, 400);
  table.scrollLeft = scrollLeft;
  table.dispatchEvent(new Event("scroll"));
  return table;
}

function nestedStreamFixture(id: string, prompt: string): NestedStreamFixture {
  return mountedTranscript([transcriptMessage(id, prompt, "user", 2)]);
}

async function grownCodeStreamFixture(
  id: string,
  prompt: string,
  scrollTop: number,
): Promise<{
  readonly initialCode: HTMLElement;
  readonly updatedCode: HTMLElement;
}> {
  const fixture = nestedStreamFixture(id, prompt);
  const { container, controller, detail } = fixture;
  const initialCode = startNestedCodeStream(
    container,
    controller,
    detail,
    scrollTop,
  );
  const updatedCode = await settledNestedStream(fixture, "code");
  return { initialCode, updatedCode };
}

function expectMessageBoundariesToRenderOnce(
  debug: RenderDebugView,
  messageIds: readonly string[],
): void {
  for (const key of messageIds) {
    expect(debug.measurement(key).count).toBe(1);
  }
}

afterEach(() => {
  disposeTestViews(disposals);
});

test("keeps a streamed code block at the user's nested scroll position", async () => {
  const { initialCode, updatedCode } = await grownCodeStreamFixture(
    "user-scroll",
    "Show the output",
    83,
  );

  expect(updatedCode).not.toBe(initialCode);
  expect(updatedCode.scrollTop).toBe(83);
});

test("keeps a bottom-pinned nested region following streamed growth", async () => {
  const { updatedCode } = await grownCodeStreamFixture(
    "user-pinned",
    "Keep following",
    300,
  );

  expect(updatedCode.scrollTop).toBe(400);
});

test.each([
  { expected: 83, label: "user position", scrollLeft: 83 },
  { expected: 400, label: "right edge", scrollLeft: 300 },
])("keeps a streamed table at the $label", async ({ expected, scrollLeft }) => {
  const fixture = nestedStreamFixture(
    `table-${String(scrollLeft)}`,
    "Show the table",
  );
  const { container, controller, detail } = fixture;
  const table = startNestedTableStream(
    container,
    controller,
    detail,
    scrollLeft,
  );
  const updatedTable = await settledNestedStream(fixture, "table");

  expect(updatedTable).not.toBe(table);
  expect(updatedTable.scrollLeft).toBe(expected);
});

function setNestedScrollPosition(
  element: HTMLElement,
  top: number,
  left: number,
): void {
  element.scrollTop = top;
  element.scrollLeft = left;
  element.dispatchEvent(new Event("scroll"));
}

function expectNestedScrollPosition(
  element: HTMLElement,
  top: number,
  left: number,
): void {
  expect(element.scrollTop).toBe(top);
  expect(element.scrollLeft).toBe(left);
}

test.each([
  {
    expectedLeft: 71,
    expectedTop: 83,
    label: "user position",
    scrollLeft: 71,
    scrollTop: 83,
  },
  {
    expectedLeft: 400,
    expectedTop: 400,
    label: "bottom-right edge",
    scrollLeft: 300,
    scrollTop: 300,
  },
])(
  "keeps nested scroll at the $label when a streamed message settles",
  async ({ expectedLeft, expectedTop, label, scrollLeft, scrollTop }) => {
    const fixture = nestedStreamFixture(`settled-${label}`, "Show the output");
    const { container, controller, detail } = fixture;
    const streamed = startNestedCodeStream(
      container,
      controller,
      detail,
      scrollTop,
    );
    defineElementWidth(streamed, 100, 400);
    setNestedScrollPosition(streamed, scrollTop, scrollLeft);

    controller.applyDetail({
      ...detail,
      messages: [
        ...detail.messages,
        transcriptMessage(
          "assistant-persisted",
          "```ts\nconst first = 1;\nconst second = 2;",
          "assistant",
          3,
        ),
      ],
      status: "idle",
      updatedAt: 3,
    });
    const persisted = codeBlock(container);
    defineElementSize(persisted, 100, 500);
    defineElementWidth(persisted, 100, 500);
    await Promise.resolve();

    expect(persisted).not.toBe(streamed);
    expectNestedScrollPosition(persisted, expectedTop, expectedLeft);
  },
);

test("keeps nested scroll positions when a persisted detail is patched", async () => {
  const message = transcriptMessage(
    "assistant-patched",
    "```ts\nconst first = 1;",
    "assistant",
    3,
  );
  const { container, controller, detail } = mountedTranscript([message]);
  const initial = codeBlock(container);
  defineElementSize(initial, 100, 400);
  defineElementWidth(initial, 100, 400);
  setNestedScrollPosition(initial, 83, 71);

  controller.applyDetail({
    ...detail,
    messages: [{ ...message, content: `${message.content}\nconst next = 2;` }],
    updatedAt: 4,
  });
  const patched = codeBlock(container);
  defineElementSize(patched, 100, 500);
  defineElementWidth(patched, 100, 500);
  await Promise.resolve();

  expect(patched).not.toBe(initial);
  expectNestedScrollPosition(patched, 83, 71);
});

test("keeps persisted and streamed turns in canonical DOM order", () => {
  const messages: AgentSessionDetail["messages"] = [
    transcriptMessage("user-earlier", "Earlier request", "user", 1),
    transcriptMessage("assistant-earlier", "Earlier answer", "assistant", 2),
    transcriptMessage("user-current", "Current request", "user", 3),
  ];
  const { container, controller, detail } = mountedTranscript(messages);
  controller.applyDetail(detail);
  const stableUser = messageBoundary(container, "user-earlier");
  const stableAssistant = messageBoundary(container, "assistant-earlier");

  applySessionDelta(controller, {
    content: "Live answer",
    sessionId: detail.id,
    thinking: "Live reasoning",
    type: "session_delta",
  });

  expectTranscriptOrder(container, [
    "user-earlier",
    "assistant-earlier",
    "user-current",
    `stream:${detail.id}:thinking`,
    `stream:${detail.id}:assistant`,
  ]);

  controller.applyDetail({
    ...detail,
    messages: [
      transcriptMessage("user-current", "Current request", "user", 3),
      transcriptMessage("assistant-earlier", "Earlier answer", "assistant", 2),
      transcriptMessage("thinking-current", "Live reasoning", "thinking", 4),
      transcriptMessage("user-earlier", "Earlier request", "user", 1),
      transcriptMessage("assistant-current", "Live answer", "assistant", 5),
    ],
    status: "idle",
    updatedAt: 5,
  });

  const expectCurrentTranscript = (): void => {
    expectTranscriptOrder(container, [
      "user-earlier",
      "assistant-earlier",
      "user-current",
      "thinking-current",
      "assistant-current",
    ]);
    expect(messageBoundary(container, "user-earlier")).toBe(stableUser);
    expect(messageBoundary(container, "assistant-earlier")).toBe(
      stableAssistant,
    );
  };
  expectCurrentTranscript();

  document.dispatchEvent(new Event("visibilitychange"));

  expectCurrentTranscript();
});

test("reconciles a persisted thinking snapshot before its assistant", () => {
  const messages: AgentSessionDetail["messages"] = [
    transcriptMessage("user-stable", "Keep this message stable", "user", 2),
    transcriptMessage(
      "assistant-stable",
      "This one is also complete",
      "assistant",
      3,
    ),
  ];
  const debug = createRenderDebugView();
  const { container, controller, detail } = mountedTranscript(messages, debug);
  const stableUser = messageBoundary(container, "user-stable");
  const stableAssistant = messageBoundary(container, "assistant-stable");

  applySessionDelta(controller, {
    content: "Streaming",
    sessionId: detail.id,
    thinking: "Streaming",
    type: "session_delta",
  });
  applySessionDelta(controller, {
    content: " response",
    sessionId: detail.id,
    thinking: " thought",
    type: "session_delta",
  });

  expectStableStreamBase(container, stableUser, stableAssistant);
  expectMessageBoundariesToRenderOnce(debug, [
    "message:user-stable",
    "message:assistant-stable",
  ]);
  expect(debug.measurement(`message:stream:${detail.id}:assistant`).count).toBe(
    2,
  );
  const streamedMessage = messageBoundary(
    container,
    `stream:${detail.id}:assistant`,
  );
  const persistedThinking = transcriptMessage(
    "thinking-persisted",
    "Streaming thought",
    "thinking",
    4,
  );
  const persistedAssistant = transcriptMessage(
    "assistant-persisted",
    "Streaming response",
    "assistant",
    5,
  );

  applyStreamSnapshot(controller, detail, messages, persistedThinking);

  expectTranscriptOrder(container, [
    "user-stable",
    "assistant-stable",
    "thinking-persisted",
    `stream:${detail.id}:assistant`,
  ]);
  expectStreamReplaced(
    container,
    detail,
    stableUser,
    stableAssistant,
    "thinking",
  );

  applyStreamSnapshot(
    controller,
    detail,
    messages,
    persistedThinking,
    persistedAssistant,
  );

  expectStreamReplaced(
    container,
    detail,
    stableUser,
    stableAssistant,
    "assistant",
    streamedMessage,
  );
  expectMessageBoundariesToRenderOnce(debug, [
    "message:user-stable",
    "message:assistant-stable",
    "message:thinking-persisted",
    "message:assistant-persisted",
  ]);
  expect(container.textContent).toContain("Streaming response");
});
