import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { summaryFromDetail } from "../../solid/session-codec.ts";
import { SessionController } from "../../solid/session-controller.ts";
import {
  countReactiveChanges,
  installFetch,
  requestUrl,
  withRestoredFetch,
} from "./controller-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  sessionDetailWithStatus,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";

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

function jsonFetch(response: unknown): typeof globalThis.fetch {
  const originalFetch = globalThis.fetch;
  return Object.assign(
    (): Promise<Response> => Promise.resolve(Response.json(response)),
    { preconnect: originalFetch.preconnect },
  );
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

function expectClearedSelection(
  controller: SessionController,
  sessions: readonly ReturnType<typeof summaryFromDetail>[],
): void {
  expect(controller.state).toMatchObject({
    detail: undefined,
    loadingDetail: false,
    selectedId: undefined,
    sessions,
  });
}

function expectAwaitingFinishedDetail(controller: SessionController): void {
  expect(controller.state.detail).toBeUndefined();
  expect(controller.state.loadingDetail).toBe(true);
}

function selectedRunningController(id: string): Promise<SessionController> {
  return selectedController(sessionDetail("running", id, []));
}

function loadedController(): Promise<SessionController> {
  globalThis.fetch = Object.assign(sessionResponse, {
    preconnect: globalThis.fetch.preconnect,
  });
  const controller = createRoot(() => new SessionController());
  return controller.load().then(() => controller);
}

test("the first realtime snapshot replaces an HTTP-loaded session list", async () => {
  await withRestoredFetch(async () => {
    const controller = await loadedController();
    expect(controller.state.sessions).toHaveLength(1);

    controller.applyRealtime([]);

    expect(controller.state.sessions).toEqual([]);
    expect(controller.state.sessionsSource).toBe("realtime");
  });
});

async function withSelectedRunning(
  id: string,
  action: (controller: SessionController) => void | Promise<void>,
): Promise<void> {
  await withRestoredFetch(async () => {
    await action(await selectedRunningController(id));
  });
}

test("realtime removal clears selection instead of half-selecting", async () => {
  await withSelectedRunning("removed-session", async (controller) => {
    controller.applyRealtime([]);
    expectClearedSelection(controller, []);

    const remaining = sessionDetail("idle", "remaining-session", []);
    const remainingSummary = summaryFromDetail(remaining);
    const secondController = await selectedRunningController("removed-session");
    secondController.applyRealtime([remainingSummary]);
    expectClearedSelection(secondController, [remainingSummary]);
  });
});

function finishedSession(controller: SessionController): AgentSessionDetail {
  const running = controller.state.detail;
  if (running === undefined) {
    throw new Error("The selected running session was not loaded");
  }
  return {
    ...running,
    messages: [assistantMessage()],
    status: "idle",
    updatedAt: running.updatedAt + 1,
  };
}

test("a matching completion snapshot preserves the finished detail", async () => {
  await withSelectedRunning("completed-session", (controller) => {
    const finished = finishedSession(controller);

    controller.applyDetail(finished);
    controller.applyRealtime([summaryFromDetail(finished)]);

    expect(controller.state).toMatchObject({
      detail: finished,
      loadingDetail: false,
      selectedId: finished.id,
      sessions: [summaryFromDetail(finished)],
    });
  });
});

test("a summary completion clears stale active detail until its detail event", async () => {
  await withRestoredFetch(async () => {
    const selected = sessionDetail("running", "completed-session", []);
    const controller = await selectedController(selected);

    controller.applyRealtime([
      { ...summaryFromDetail(selected), status: "idle", updatedAt: 10 },
    ]);

    expectAwaitingFinishedDetail(controller);
    expect(controller.state.selectedId).toBe(selected.id);
  });
});

test("ignores a delayed detail older than an authoritative summary", async () => {
  await withRestoredFetch(async () => {
    const current = sessionDetail("running", "ordered-session", []);
    const controller = await selectedController(current);
    controller.applyRealtime([
      { ...summaryFromDetail(current), status: "idle", updatedAt: 10 },
    ]);

    controller.applyDetail({ ...current, updatedAt: 9 });

    expectAwaitingFinishedDetail(controller);
  });
});

test("ignores selection requests for stale panel entries", async () => {
  await withRestoredFetch(async () => {
    let requests = 0;
    globalThis.fetch = Object.assign(
      (): Promise<Response> => {
        requests += 1;
        return Promise.resolve(Response.json(TEST_SESSION_DETAIL));
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const controller = createRoot(() => new SessionController());
    controller.applyRealtime([]);

    await controller.select("stale-session");

    expect(requests).toBe(0);
    expect(controller.state.selectedId).toBeUndefined();
  });
});

test("orders same-timestamp session details deterministically", async () => {
  await withRestoredFetch(async () => {
    const first = sessionDetail("running", "session-a", []);
    const controller = await selectedController(first);
    const laterId = { ...first, id: "session-b" };

    controller.applyRealtime([
      summaryFromDetail(first),
      summaryFromDetail(laterId),
    ]);

    expect(controller.state.sessions?.map(({ id }) => id)).toEqual([
      "session-b",
      "session-a",
    ]);
  });
});

test("an unchanged realtime snapshot does not notify the view", async () => {
  await withRestoredFetch(async () => {
    await createRoot(async (dispose) => {
      const controller = await loadedController();
      const session = summaryFromDetail(TEST_SESSION_DETAIL);
      const changes = countReactiveChanges(controller);

      controller.applyRealtime([session]);
      const changesAfterSnapshot = changes.count();
      controller.applyRealtime([{ ...session }]);

      expect(changes.count()).toBe(changesAfterSnapshot);
      dispose();
    });
  });
});
