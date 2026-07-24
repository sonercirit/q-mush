import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { summaryFromDetail } from "../../solid/session-codec.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import {
  DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  writeSessionTranscriptFilters,
} from "../../solid/session-transcript-filters.ts";
import type { SessionCommandTransport } from "../../solid/session-transport.ts";
import {
  expectRealtimeControllerToRemainSilent,
  type SilentRealtimeController,
} from "./controller-test-helpers.ts";
import { MemoryStorage } from "./memory-storage.ts";
import {
  recordingCommand,
  type SessionCommandCall,
} from "./session-command-call.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  sessionDetailWithStatus,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";

class SessionTestTransport implements SessionCommandTransport {
  readonly calls: SessionCommandCall[] = [];
  readonly #readDetail: AgentSessionDetail;
  #mutationDetail: AgentSessionDetail;

  constructor(detail: AgentSessionDetail) {
    this.#readDetail = detail;
    this.#mutationDetail = detail;
  }

  command(
    ...parameters: [string, Readonly<Record<string, unknown>>]
  ): Promise<unknown> {
    const [operation, payload] = parameters;
    recordingCommand(this.calls, operation, payload);
    return this.#result(operation);
  }

  #result(operation: string): Promise<unknown> {
    if (operation === SESSION_REALTIME_OPERATIONS.subscribe) {
      return Promise.resolve({
        sessions: [summaryFromDetail(this.#readDetail)],
      });
    }
    if (operation === SESSION_REALTIME_OPERATIONS.read) {
      return Promise.resolve({ session: this.#readDetail });
    }
    return Promise.resolve(this.#mutationDetail);
  }

  setMutationDetail(detail: AgentSessionDetail): void {
    this.#mutationDetail = detail;
  }
}

function controllerWithTransport(
  transport: SessionCommandTransport,
  reactive = createReactiveState(initialSessionViewState()),
): SessionController {
  return createRoot(
    () => new SessionController(reactive, undefined, null, transport),
  );
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
  expect(messageIds(controller)).toEqual([
    ...persistedIds,
    ...streamMessageIds(sessionId, thinking),
  ]);
}

interface SelectedTurn {
  readonly assistant?: AgentSessionDetail["messages"][number];
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
  readonly transport: SessionTestTransport;
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
  const transport = new SessionTestTransport(detail);
  const controller = controllerWithTransport(transport);
  await controller.select(detail.id);
  return {
    ...(assistant === undefined ? {} : { assistant }),
    controller,
    detail,
    transport,
    user,
  };
}

async function runningTurnValues(
  sessionId: string,
): Promise<
  readonly [
    SessionController,
    AgentSessionDetail,
    AgentSessionDetail["messages"][number],
  ]
> {
  const turn = await selectedRunningTurn(sessionId);
  return [turn.controller, turn.detail, turn.user];
}

async function selectedRunningTurn(sessionId: string): Promise<SelectedTurn> {
  return selectedTurn(sessionId, "running");
}

async function selectedIdleTurn(sessionId: string): Promise<SelectedIdleTurn> {
  return selectedTurn(sessionId, "idle");
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

test("renders incremental model deltas in the selected transcript", async () => {
  const transport = new SessionTestTransport(TEST_SESSION_DETAIL);
  const controller = controllerWithTransport(transport);

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
});

test("ignores stale deltas after a finished snapshot and accepts a queued continuation", async () => {
  const [controller, running, user] = await runningTurnValues(
    "session-stale-delta",
  );
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

test("anchors a follow-up stream after the newly persisted user message", async () => {
  const { assistant, controller, detail, transport, user } =
    await selectedIdleTurn("session-follow-up");
  const sessionId = detail.id;
  const followUp = transcriptMessage("user-2", "Follow up", "user", 3);
  transport.setMutationDetail(
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

test("anchors a continuation stream after the existing transcript", async () => {
  const turn = await selectedIdleTurn("session-continuation");
  const { assistant, controller, detail, transport, user } = turn;
  const sessionId = detail.id;
  transport.setMutationDetail(queuedDetail(detail));
  await controller.continueSession();
  applyDelta(controller, sessionId, "Continued response", "");

  expectStreamAfter(controller, [user.id, assistant.id], sessionId, false);
});

test("reconciles reset streams with persisted messages", async () => {
  const [controller, running, user] = await runningTurnValues("session-stream");
  const sessionId = running.id;

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
  const pending = new Map<string, (value: unknown) => void>();
  const transport: SessionCommandTransport = {
    command: (operation, payload) => {
      const sessionId = payload["sessionId"];
      if (
        operation !== SESSION_REALTIME_OPERATIONS.read ||
        typeof sessionId !== "string"
      ) {
        return Promise.reject(new Error("Unexpected session command"));
      }
      return new Promise((resolve) => {
        pending.set(sessionId, resolve);
      });
    },
  };
  const controller = controllerWithTransport(transport);

  const selectFirst = controller.select(first.id);
  const selectSecond = controller.select(second.id);
  applyDelta(controller, first.id, "First live", "");
  applyDelta(controller, second.id, "Second live", "");

  pending.get(second.id)?.({ session: second });
  await selectSecond;
  const secondMessages = ["second-user", `stream:${second.id}:assistant`];
  expect(messageIds(controller)).toEqual(secondMessages);

  pending.get(first.id)?.({ session: first });
  await selectFirst;
  expect(controller.state.selectedId).toBe(second.id);
  expect(messageIds(controller)).toEqual(secondMessages);
});

test("replaces a streaming transcript with a compacted snapshot", async () => {
  const sessionId = "session-compaction";
  const original = sessionDetail("running", sessionId, [
    transcriptMessage("old-user", "Original request", "user", 1),
  ]);
  const transport = new SessionTestTransport(original);
  const controller = controllerWithTransport(transport);
  await controller.select(original.id);
  applyDelta(controller, sessionId, "Temporary", "Temporary thinking");
  const compacted = transcriptMessage(
    "compacted",
    "Conversation compacted",
    "user",
    5,
  );
  finishSession(controller, original, [compacted]);

  expect(messageIds(controller)).toEqual([compacted.id]);
});

test("loads persisted transcript filters into the controller and keeps them on reset", () => {
  const storage = new MemoryStorage();
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
    const transport = new SessionTestTransport(detail);
    const controller = controllerWithTransport(transport, reactive);

    await controller[action]();

    expect(transport.calls).toEqual([]);
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
    const transport = new SessionTestTransport(TEST_SESSION_DETAIL);
    const controller = new SessionController(
      reactive,
      undefined,
      null,
      transport,
    );

    if (action === "toggleAutoCompact") {
      await controller.toggleAutoCompact(false);
    } else {
      await controller[action]();
    }

    expect(transport.calls).toEqual([]);
  },
);

test("an unchanged session refresh does not notify the view", async () => {
  const transport = new SessionTestTransport(TEST_SESSION_DETAIL);
  await expectRealtimeControllerToRemainSilent(
    (): SilentRealtimeController<
      readonly ReturnType<typeof summaryFromDetail>[]
    > => new SessionController(undefined, undefined, null, transport),
    [summaryFromDetail(TEST_SESSION_DETAIL)],
  );
});
