import { createRoot } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { summaryFromDetail } from "../../solid/session-codec.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import {
  DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  writeSessionTranscriptFilters,
} from "../../solid/session-transcript-filters.ts";
import {
  expectRealtimeToRemainSilent,
  requestUrl,
} from "./controller-test-helpers.ts";
import { MemoryStorage } from "./memory-storage.ts";
import { createResponseFetch } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  sessionDetailWithStatus,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

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
  expect(messageIds(controller)).toEqual([
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

async function withRestoredFetch(action: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  controller.applyDelta({
    content,
    ...(reset ? { reset: true } : {}),
    sessionId,
    thinking,
    type: "session_delta",
  });
}

function messageIds(controller: SessionController): readonly string[] {
  return controller.state.detail?.messages.map(({ id }) => id) ?? [];
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

function installFetch(
  implementation: (
    ...parameters: Parameters<typeof fetch>
  ) => Promise<Response>,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
}

function jsonFetch(response: unknown): typeof globalThis.fetch {
  return createResponseFetch(response);
}

function selectedController(
  selected: AgentSessionDetail,
): Promise<SessionController> {
  globalThis.fetch = jsonFetch(selected);
  const controller = createRoot(() => new SessionController());
  return controller.select(selected.id).then(() => controller);
}

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

    expect(messageIds(controller)).toEqual([user.id, assistant.id]);

    controller.applyDetail(queuedDetail(running, [user, assistant]));
    applyDelta(controller, sessionId, "Continuation", "Fresh thinking");

    expectStreamAfter(controller, [user.id, assistant.id], sessionId, true);
  });
});

test("anchors a follow-up stream after the newly persisted user message", async () => {
  await withRestoredFetch(async () => {
    const { assistant, controller, detail, user } =
      await selectedIdleTurn("session-follow-up");
    const sessionId = detail.id;
    const followUp = transcriptMessage("user-2", "Follow up", "user", 3);
    globalThis.fetch = jsonFetch(
      queuedDetail(detail, [user, assistant, followUp]),
    );
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
    const { assistant, controller, detail, user } = turn;
    const sessionId = detail.id;
    globalThis.fetch = jsonFetch(queuedDetail(detail));
    await controller.continueSession();
    applyDelta(controller, sessionId, "Continued response", "");

    expectStreamAfter(controller, [user.id, assistant.id], sessionId, false);
  });
});

test("reconciles reset streams with persisted messages", async () => {
  const originalFetch = globalThis.fetch;
  const {
    controller,
    detail: running,
    user,
  } = await selectedTurn("session-stream", "running");
  const sessionId = running.id;

  try {
    applyDelta(controller, sessionId, "Discarded", "Old thinking");
    applyDelta(controller, sessionId, "Replacement", "New thinking", true);

    finishSession(controller, running, [
      user,
      transcriptMessage("thinking-1", "New thinking", "thinking", 2),
      transcriptMessage("assistant-1", "Replacement", "assistant", 3),
    ]);

    expect(messageIds(controller)).toEqual([
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
    expect(messageIds(controller)).toEqual(secondMessages);

    pending.get(first.id)?.(Response.json(first));
    await selectFirst;
    expect(controller.state.selectedId).toBe(second.id);
    expect(messageIds(controller)).toEqual(secondMessages);
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

    expect(messageIds(controller)).toEqual([compacted.id]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loads persisted transcript filters and keeps them across resets and workspaces", () => {
  const storage = new MemoryStorage();
  writeSessionTranscriptFilters(storage, {
    ...DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    toolDefinitions: true,
  });
  const controller = new SessionController(
    createReactiveState(initialSessionViewState()),
    undefined,
    storage,
  );

  expect(controller.state.transcriptFilters.toolDefinitions).toBe(true);
  controller.setWorkspace("workspace-projects");
  expect(controller.state.transcriptFilters.toolDefinitions).toBe(true);
  controller.reset();
  expect(controller.state.transcriptFilters.toolDefinitions).toBe(true);
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

test.each(["compact", "continueSession", "stop", "toggleAutoCompact"] as const)(
  "rejects %s when the detail does not match the selected session",
  async (action) => {
    const reactive = createReactiveState<SessionViewState>({
      ...initialSessionViewState(),
      detail: { ...TEST_SESSION_DETAIL, id: "stale-detail" },
      selectedId: TEST_SESSION_DETAIL.id,
    });
    const controller = new SessionController(reactive, undefined, null);
    const fetch = vi.spyOn(globalThis, "fetch");

    if (action === "toggleAutoCompact") {
      await controller.toggleAutoCompact(false);
    } else {
      await controller[action]();
    }

    expect(fetch).not.toHaveBeenCalled();
  },
);

test("uses the selected workspace for model discovery", async () => {
  const controller = createRoot(() => new SessionController());
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      requests.push(url);
      return Promise.resolve(
        Response.json(
          url.includes("/models?")
            ? {
                defaultModel: "gpt-4.1-mini",
                models: [
                  {
                    contextWindow: 128_000,
                    id: "gpt-4.1-mini",
                    inputModalities: ["text"],
                    label: "GPT-4.1 mini",
                    outputModalities: ["text"],
                    pricing: null,
                    reasoningEfforts: [],
                  },
                ],
              }
            : { sessions: [] },
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );

  try {
    controller.setWorkspace("workspace-projects");
    controller.initializeDefaults("runner-1", "openai:credential-1", true);
    await vi.waitFor(() => {
      expect(requests.some((url) => url.includes("/models?"))).toBe(true);
    });
    expect(requests.find((url) => url.includes("/models?"))).toContain(
      "workspaceId=workspace-projects",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("an unchanged session refresh does not notify the view", async () => {
  await expectRealtimeToRemainSilent(
    () => new SessionController(),
    sessionResponse,
    [summaryFromDetail(TEST_SESSION_DETAIL)],
  );
});
