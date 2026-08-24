import { createRoot } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { SessionController } from "../../solid/session-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import { summaryFromDetail } from "../../solid/session-summary-codec.ts";
import {
  DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  writeSessionTranscriptFilters,
} from "../../solid/session-transcript-filters.ts";
import {
  expectRealtimeToRemainSilent,
  installFetch,
  requestUrl,
  withRestoredFetch,
} from "./controller-test-helpers.ts";
import { createMemoryStorage } from "./memory-storage.ts";
import { applySessionDelta } from "./session-controller-stream-test-helper.ts";
import { createResponseFetch } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  sessionDetailWithStatus,
  sessionMessageIds,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";
afterEach(() => {
  vi.restoreAllMocks();
});
function selectedSessionState(state: SessionViewState): SessionViewState {
  return { ...state, selectedId: TEST_SESSION_DETAIL.id };
}
function promptDraft(state: SessionViewState, prompt: string) {
  return {
    ...state.draft,
    credential: "credential-1",
    model: "model-1",
    prompt,
    reasoningEffort: "high" as const,
    runnerId: "runner-1",
    workingDirectory: "/workspace",
  };
}
function assistantMessage(id = "assistant-1", content = "Response") {
  return transcriptMessage(id, content, "assistant", 2);
}
function streamMessageIds(
  sessionId: string,
  thinking: boolean,
): readonly string[] {
  return [
    ...(thinking ? [`stream:${sessionId}:thinking`] : []),
    `stream:${sessionId}:assistant`,
  ];
}
function expectStreamAfter(
  controller: SessionController,
  persistedIds: readonly string[],
  sessionId: string,
  thinking: boolean,
): void {
  expect(sessionMessageIds(controller)).toEqual([
    ...persistedIds,
    ...streamMessageIds(sessionId, thinking),
  ]);
}
interface SelectedTurn {
  readonly assistant?: AgentSessionDetail["messages"][number];
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
  readonly user: AgentSessionDetail["messages"][number];
}
interface SelectedIdleTurn extends SelectedTurn {
  readonly assistant: AgentSessionDetail["messages"][number];
}
function selectedTurn(
  sessionId: string,
  status: "idle",
): Promise<SelectedIdleTurn>;
function selectedTurn(
  sessionId: string,
  status: "running",
): Promise<SelectedTurn>;
async function selectedTurn(
  sessionId: string,
  status: "idle" | "running",
): Promise<SelectedTurn> {
  const user = transcriptMessage("user-1", "Request", "user", 1);
  const assistant = status === "idle" ? assistantMessage() : undefined;
  const detail = sessionDetail(
    status,
    sessionId,
    assistant === undefined ? [user] : [user, assistant],
  );
  return {
    ...(assistant === undefined ? {} : { assistant }),
    controller: await selectedController(detail),
    detail,
    user,
  };
}
async function selectedIdleTurn(sessionId: string): Promise<SelectedIdleTurn> {
  return selectedTurn(sessionId, "idle");
}

function sessionResponse(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(requestUrl(input), "http://localhost").pathname;
  return Promise.resolve(
    Response.json(
      path === SESSIONS_PATH
        ? { sessions: [summaryFromDetail(TEST_SESSION_DETAIL)] }
        : TEST_SESSION_DETAIL,
    ),
  );
}

function applyDelta(
  controller: SessionController,
  sessionId: string,
  content: string,
  thinking: string,
  reset = false,
): void {
  applySessionDelta(controller, {
    content,
    ...(reset ? { reset: true } : {}),
    sessionId,
    thinking,
    type: "session_delta",
  });
}

function sessionDetail(
  status: AgentSessionDetail["status"],
  sessionId: string,
  messages: AgentSessionDetail["messages"],
): AgentSessionDetail {
  return sessionDetailWithStatus(status, messages, sessionId);
}

function finishSession(
  controller: SessionController,
  detail: AgentSessionDetail,
  messages: AgentSessionDetail["messages"],
): void {
  controller.applyDetail({ ...detail, messages, status: "idle" });
}

function queuedDetail(
  detail: AgentSessionDetail,
  messages: AgentSessionDetail["messages"] = detail.messages,
): AgentSessionDetail {
  return { ...detail, messages, status: "queued" };
}

function jsonFetch(response: unknown): typeof globalThis.fetch {
  return createResponseFetch(response);
}

function selectedController(
  selected: AgentSessionDetail,
  transport?: ConstructorParameters<typeof SessionController>[3],
): Promise<SessionController> {
  globalThis.fetch = jsonFetch(selected);
  const controller = createRoot(
    () => new SessionController(undefined, undefined, undefined, transport),
  );
  return controller.select(selected.id).then(() => controller);
}

async function selectedControllerWithCommand(
  selected: AgentSessionDetail,
  command: NonNullable<
    ConstructorParameters<typeof SessionController>[3]
  >["command"],
): Promise<SessionController> {
  return selectedController(selected, { command });
}

async function expectReadCommand(
  command: ReturnType<typeof vi.fn>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(command.mock.calls).toContainEqual([
      "sessions.read",
      { sessionId: TEST_SESSION_DETAIL.id },
    ]);
  });
}

function queuedCommand(
  detail: AgentSessionDetail,
  messages: AgentSessionDetail["messages"] = detail.messages,
): NonNullable<ConstructorParameters<typeof SessionController>[3]>["command"] {
  return () => Promise.resolve(queuedDetail(detail, messages));
}

test("posts an explicit runner reassignment without starting the session", async () => {
  const required = { ...TEST_SESSION_DETAIL, runnerRequired: true };
  const reactive = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    detail: required,
    reassignment: {
      runnerId: "runner-2",
      workingDirectory: "/replacement/project",
    },
    selectedId: required.id,
    sessions: [required],
  });
  const controller = createRoot(
    () =>
      new SessionController(reactive, undefined, undefined, {
        command: (_operation, payload) =>
          Promise.resolve({
            ...required,
            runnerId: String(payload["runnerId"]),
            runnerRequired: false,
            workingDirectory: String(payload["workingDirectory"]),
          }),
      }),
  );
  const fetch = vi.spyOn(globalThis, "fetch");

  await controller.reassign(["runner-2"]);

  expect(fetch).not.toHaveBeenCalled();
  expect(controller.state.detail).toEqual(
    expect.objectContaining({
      runnerId: "runner-2",
      runnerRequired: false,
      status: "idle",
    }),
  );
});

test("renders incremental model deltas in the selected transcript", async () => {
  const controller = createRoot(() => new SessionController());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(sessionResponse, {
    preconnect: originalFetch.preconnect,
  });

  try {
    await controller.load();
    expect(controller.state.draft.workingDirectory).toBe(
      TEST_SESSION_DETAIL.workingDirectory,
    );
    applyDelta(controller, TEST_SESSION_DETAIL.id, "Hello", "Considering");
    applyDelta(controller, TEST_SESSION_DETAIL.id, " world", " carefully");
    applyDelta(controller, TEST_SESSION_DETAIL.id, "", "", true);

    expect(controller.state.detail?.messages).toEqual([]);

    controller.applyDetail({ ...TEST_SESSION_DETAIL, status: "queued" });
    applyDelta(
      controller,
      TEST_SESSION_DETAIL.id,
      "Replacement",
      "Reconsidering",
    );

    expect(controller.state.detail?.messages.slice(-2)).toMatchObject([
      { content: "Reconsidering", role: "thinking" },
      { content: "Replacement", role: "assistant" },
    ]);

    const errorMessage = {
      content: "Session failed: the provider connection was lost",
      createdAt: 3,
      id: "error-1",
      images: [],
      role: "error" as const,
      toolCallId: null,
      toolCalls: [],
      toolName: null,
    };
    controller.applyDetail({
      ...TEST_SESSION_DETAIL,
      messages: [errorMessage],
      status: "failed",
      updatedAt: 3,
    });
    expect(controller.state.detail?.messages).toEqual([errorMessage]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ignores stale deltas after a finished snapshot and accepts a queued continuation", async () => {
  await withRestoredFetch(async () => {
    const {
      controller,
      detail: running,
      user,
    } = await selectedTurn("session-stale-delta", "running");
    const sessionId = running.id;
    const assistant = assistantMessage("assistant-1", "Finished response");
    applyDelta(controller, sessionId, "Finished response", "");
    finishSession(controller, running, [user, assistant]);
    applyDelta(controller, sessionId, " stale", "stale thinking");

    expect(sessionMessageIds(controller)).toEqual([user.id, assistant.id]);

    controller.applyDetail(queuedDetail(running, [user, assistant]));
    applyDelta(controller, sessionId, "Continuation", "Fresh thinking");

    expectStreamAfter(controller, [user.id, assistant.id], sessionId, true);
  });
});

test("anchors a follow-up stream after the newly persisted user message", async () => {
  await withRestoredFetch(async () => {
    const { assistant, detail, user } =
      await selectedIdleTurn("session-follow-up");
    const followUp = transcriptMessage("user-2", "Follow up", "user", 3);
    const controller = await selectedControllerWithCommand(
      detail,
      queuedCommand(detail, [user, assistant, followUp]),
    );
    const sessionId = detail.id;
    controller.setFollowUp(followUp.content);
    await controller.send();
    applyDelta(controller, sessionId, "Follow-up response", "");

    expectStreamAfter(
      controller,
      [user.id, assistant.id, followUp.id],
      sessionId,
      false,
    );
  });
});

test("anchors a continuation stream after the existing transcript", async () => {
  await withRestoredFetch(async () => {
    const turn = await selectedIdleTurn("session-continuation");
    const { assistant, detail, user } = turn;
    const controller = await selectedControllerWithCommand(
      detail,
      queuedCommand(detail),
    );
    const sessionId = detail.id;
    await controller.continueSession();
    applyDelta(controller, sessionId, "Continued response", "");

    expectStreamAfter(controller, [user.id, assistant.id], sessionId, false);
  });
});

test("reconciles reset streams with differently finalized persisted messages", async () => {
  const originalFetch = globalThis.fetch;
  const {
    controller,
    detail: running,
    user,
  } = await selectedTurn("session-stream", "running");
  const sessionId = running.id;

  try {
    applyDelta(controller, sessionId, "Discarded", "Old thinking");
    applyDelta(controller, sessionId, "Replacement ", "New thinking", true);
    expectStreamAfter(controller, [user.id], sessionId, true);

    controller.applyDetail(
      queuedDetail(running, [
        user,
        transcriptMessage("thinking-1", "New thinking", "thinking", 2),
        transcriptMessage("assistant-1", "Replacement", "assistant", 3),
      ]),
    );

    expect(sessionMessageIds(controller)).toEqual([
      "user-1",
      "thinking-1",
      "assistant-1",
    ]);
    expect(controller.state.detail?.messages).toHaveLength(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps per-session streams isolated across rapid selection changes", async () => {
  const first: AgentSessionDetail = {
    ...TEST_SESSION_DETAIL,
    id: "session-first",
    messages: [transcriptMessage("first-user", "First request", "user", 1)],
    status: "running",
  };
  const second: AgentSessionDetail = {
    ...first,
    id: "session-second",
    messages: [transcriptMessage("second-user", "Second request", "user", 1)],
  };
  const pending = new Map<string, (response: Response) => void>();
  const originalFetch = globalThis.fetch;
  installFetch((input) => {
    const path = new URL(requestUrl(input), "http://localhost").pathname;
    const sessionId = path.slice(path.lastIndexOf("/") + 1);
    return new Promise((resolve) => {
      pending.set(sessionId, resolve);
    });
  });
  const controller = createRoot(() => new SessionController());

  try {
    const selectFirst = controller.select(first.id);
    const selectSecond = controller.select(second.id);
    applyDelta(controller, first.id, "First live", "");
    applyDelta(controller, second.id, "Second live", "");

    pending.get(second.id)?.(Response.json(second));
    await selectSecond;
    const secondMessages = ["second-user", `stream:${second.id}:assistant`];
    expect(sessionMessageIds(controller)).toEqual(secondMessages);

    pending.get(first.id)?.(Response.json(first));
    await selectFirst;
    expect(controller.state.selectedId).toBe(second.id);
    expect(sessionMessageIds(controller)).toEqual(secondMessages);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("replaces a streaming transcript with a compacted snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const sessionId = "session-compaction";
  const original = sessionDetail("running", sessionId, [
    transcriptMessage("old-user", "Original request", "user", 1),
  ]);

  try {
    const controller = await selectedController(original);
    applyDelta(controller, sessionId, "Temporary", "Temporary thinking");
    const compacted = transcriptMessage(
      "compacted",
      "Conversation compacted",
      "user",
      5,
    );
    finishSession(controller, original, [compacted]);

    expect(sessionMessageIds(controller)).toEqual([compacted.id]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loads persisted transcript filters into the controller and keeps them on reset", () => {
  const storage = createMemoryStorage();
  writeSessionTranscriptFilters(storage, {
    ...DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    toolDefinitions: false,
  });
  const controller = new SessionController(
    createReactiveState(initialSessionViewState()),
    undefined,
    storage,
  );

  expect(controller.state.transcriptFilters.toolDefinitions).toBe(false);
  controller.reset();
  expect(controller.state.transcriptFilters.toolDefinitions).toBe(false);
});

test.each([
  { action: "send", busy: { compacting: true } },
  { action: "continueSession", busy: { stopping: true } },
  { action: "stop", busy: { sending: true } },
] as const)(
  "guards invalid or duplicate $action mutations in the controller",
  async ({ action, busy }) => {
    const active = action === "stop";
    const detail = {
      ...TEST_SESSION_DETAIL,
      status: active ? ("idle" as const) : ("running" as const),
    };
    const reactive = createReactiveState<SessionViewState>({
      ...initialSessionViewState(),
      ...busy,
      detail,
      followUp: "Do not submit",
      selectedId: detail.id,
    });
    const controller = new SessionController(reactive);
    const fetch = vi.spyOn(globalThis, "fetch");

    await controller[action]();

    expect(fetch).not.toHaveBeenCalled();
    expect(controller.state.followUp).toBe("Do not submit");
  },
);

test.each([
  "compact",
  "continueSession",
  "stop",
  "autoCompact",
  "idleCompact",
] as const)(
  "rejects %s when the detail does not match the selected session",
  async (action) => {
    const reactive = createReactiveState<SessionViewState>(
      selectedSessionState({
        ...initialSessionViewState(),
        detail: { ...TEST_SESSION_DETAIL, id: "stale-detail" },
      }),
    );
    const controller = new SessionController(reactive, undefined, null);
    const fetch = vi.spyOn(globalThis, "fetch");

    await (action === "autoCompact" || action === "idleCompact"
      ? controller.toggleCompactionFlag(action, false)
      : controller[action]());

    expect(fetch).not.toHaveBeenCalled();
  },
);
test("decodes a realtime read result as session detail", async () => {
  const transport = {
    command: vi.fn(() => Promise.resolve(TEST_SESSION_DETAIL)),
  };
  const controller = new SessionController(
    undefined,
    undefined,
    undefined,
    transport,
  );

  await controller.select(TEST_SESSION_DETAIL.id);

  await expectReadCommand(transport.command);
  expect(controller.state.detail).toEqual(TEST_SESSION_DETAIL);
  expect(controller.state.error).toBeUndefined();
});

test("hydrates the selected session list and detail after a realtime reconnect", async () => {
  let reconnect: (() => void) | undefined;
  const hydrated = { ...TEST_SESSION_DETAIL, status: "failed" as const };
  const transport = {
    command: vi.fn((operation: string) =>
      Promise.resolve(
        operation === SESSION_REALTIME_OPERATIONS.subscribe
          ? { sessions: [summaryFromDetail(hydrated)] }
          : hydrated,
      ),
    ),
    onReconnect(listener: () => void) {
      reconnect = listener;
      return () => undefined;
    },
  };
  const reactive = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    detail: TEST_SESSION_DETAIL,
    selectedId: TEST_SESSION_DETAIL.id,
    sessions: [TEST_SESSION_DETAIL],
  });
  const controller = new SessionController(
    reactive,
    undefined,
    undefined,
    transport,
  );

  reconnect?.();
  await expectReadCommand(transport.command);
  expect(controller.state.detail?.status).toBe("failed");
});

test("inserting a saved prompt only changes the new-session draft", () => {
  const initial = initialSessionViewState();
  const reactive = createReactiveState<SessionViewState>(
    selectedSessionState({
      ...initial,
      draft: promptDraft(initial, "Existing draft"),
      followUp: "Existing follow-up",
      openSelect: "model",
    }),
  );

  const controller = new SessionController(reactive, undefined, null);

  expect(controller.insertPrompt("Saved prompt")).toBe(false);
  expect(controller.insertPrompt("Saved prompt", true)).toBe(true);
  expect(controller.state).toMatchObject({
    draft: promptDraft(initial, "Saved prompt"),
    followUp: "Existing follow-up",
    openSelect: "model",
    selectedId: TEST_SESSION_DETAIL.id,
  });
});

test("an unchanged session refresh does not notify the view", async () => {
  await expectRealtimeToRemainSilent(
    () => new SessionController(),
    sessionResponse,
    [summaryFromDetail(TEST_SESSION_DETAIL)],
  );
});

test("matching session snapshots skip serializing retained message content", () => {
  const content = "x".repeat(100_000);
  const message = transcriptMessage("assistant-large", content, "assistant", 2);
  const detail = {
    ...TEST_SESSION_DETAIL,
    messages: [message],
    status: "running" as const,
  };
  const reactive = createReactiveState<SessionViewState>(
    selectedSessionState({
      ...initialSessionViewState(),
      detail,
      sessions: [summaryFromDetail(detail)],
    }),
  );
  const controller = new SessionController(reactive);
  const toJSON = vi.fn(() => {
    throw new Error("message content was serialized");
  });
  const refreshedMessage = { ...message };

  Object.defineProperty(message, "toJSON", { value: toJSON });
  Object.defineProperty(refreshedMessage, "toJSON", { value: toJSON });

  expect(() => {
    controller.applyDetail({ ...detail, messages: [refreshedMessage] });
  }).not.toThrow();
  expect(controller.state.detail?.messages[0]).toBe(message);
  expect(toJSON).not.toHaveBeenCalled();
});
