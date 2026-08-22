import { createEffect, createRoot } from "solid-js";
import { afterEach, expect, test } from "vitest";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../../shared/session-model.ts";
import {
  createProviderViewState,
  type ProviderCredential,
} from "../provider-credential-model.ts";
import {
  RealtimeStreamBuffer,
  type RealtimeClientEvent,
} from "../realtime-stream-buffer.ts";
import { createRunnerViewState } from "../runner-client.tsx";
import { SessionPanel } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
import { mountTestView } from "./dom-test-helpers.ts";
import { realtimeTestSetup } from "./realtime-client-test-setup.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { mountTestSessionDetail } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { transcriptMessage } from "./transcript-ordering-fixtures.ts";

const disposals: (() => void)[] = [];

function largeRunningDetail(): AgentSessionDetail {
  const content = "Reconnect transcript content. ".repeat(64);
  return {
    ...TEST_SESSION_DETAIL,
    messages: Array.from({ length: 80 }, (_, index) =>
      transcriptMessage(
        `message-${String(index)}`,
        content,
        index % 2 === 0 ? "user" : "assistant",
        index + 1,
      ),
    ),
    status: "running",
  };
}

function sessionSnapshot(
  selected: AgentSessionDetail,
  count: number,
): readonly AgentSessionSummary[] {
  const base = summaryFromDetail(TEST_SESSION_DETAIL);
  return [
    summaryFromDetail(selected),
    ...Array.from({ length: count - 1 }, (_, index) => ({
      ...base,
      id: `background-${String(index)}`,
      title: `Background ${String(index)}`,
      updatedAt: count - index,
    })),
  ];
}

const TEST_CREDENTIAL: ProviderCredential = {
  accountId: null,
  id: "credential-typing-profile",
  isDefault: true,
  label: "Typing profile credential",
  source: "api_key",
};

function mountRealSessionPanel(detail: AgentSessionDetail) {
  const controller = new SessionController(
    sessionDetailState(detail, sessionSnapshot(detail, 100)),
  );
  const provider = () => createProviderViewState([TEST_CREDENTIAL]);
  const runner = () => createRunnerViewState([runnerSummary(1)]);
  const panel = () =>
    SessionPanel({
      controller,
      openAi: provider,
      openRouter: provider,
      runners: runner,
    });
  const container = mountTestView(panel, disposals);
  return { container, controller };
}

function applySessionEvent(
  controller: SessionController,
  event: RealtimeClientEvent,
): boolean {
  if (event.type === "session") {
    controller.applyDetail(event.session);
    return true;
  }
  if (event.type === "sessions") {
    controller.applyRealtime(event.sessions);
    return true;
  }
  return false;
}

afterEach(() => {
  document.body.replaceChildren();
  while (disposals.length > 0) disposals.pop()?.();
});

test("a large reconnect recovery burst yields between bounded view updates", () => {
  const detail = largeRunningDetail();
  const mounted = mountTestSessionDetail(detail, disposals);
  const controller = mounted.controller;
  const prompt = mounted.container.querySelector(
    "[data-session-composer='true'] textarea[name='prompt']",
  );
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError("Expected a follow-up composer textarea");
  }

  const frames: (() => void)[] = [];
  let snapshotApplications = 0;
  const setup = realtimeTestSetup({
    listener: (event) => {
      if (applySessionEvent(controller, event)) snapshotApplications += 1;
    },
    requestFrame: (scheduled) => {
      const frameId = frames.length + 101;
      frames.push(scheduled);
      return frameId;
    },
  });
  disposals.push(setup.connection.stop.bind(setup.connection));

  let viewUpdates = 0;
  disposals.push(
    createRoot((dispose) => {
      createEffect(() => {
        controller.view();
        viewUpdates += 1;
      });
      return dispose;
    }),
  );
  viewUpdates = 0;

  setup.sockets[0]?.open("before-restart");
  setup.sockets[0]?.close();
  setup.timers.shift()?.();
  setup.sockets[1]?.open("after-restart");
  const reconnected = setup.sockets[1];
  if (reconnected === undefined) {
    throw new TypeError("The realtime client did not reconnect");
  }

  const recoveryUpdates = 40;
  for (let update = 1; update <= recoveryUpdates; update += 1) {
    const recovered = {
      ...detail,
      currentContextTokens: detail.currentContextTokens + update,
      updatedAt: detail.updatedAt + update,
    };
    reconnected.receive({ session: recovered, type: "session" });
    reconnected.receive({
      sessions: sessionSnapshot(recovered, 100),
      type: "sessions",
    });
  }

  expect(snapshotApplications).toBe(0);
  expect(viewUpdates).toBe(0);
  expect(frames).toHaveLength(1);

  prompt.value = "a";
  prompt.dispatchEvent(new InputEvent("input", { bubbles: true }));
  frames.shift()?.();

  expect(snapshotApplications).toBe(1);
  expect(viewUpdates).toBe(2);
  expect(prompt.value).toBe("a");
  expect(frames).toHaveLength(1);

  prompt.value = `${prompt.value}b`;
  prompt.dispatchEvent(new InputEvent("input"));
  const nextFrame = frames.shift();
  if (nextFrame === undefined) {
    throw new TypeError("Expected a second recovery frame");
  }
  nextFrame();

  expect([snapshotApplications, viewUpdates, prompt.value]).toEqual([
    2,
    3,
    "ab",
  ]);
  expect(controller.state.detail?.updatedAt).toBe(
    detail.updatedAt + recoveryUpdates,
  );
  expect(controller.state.sessions).toHaveLength(100);
});

test("a superseded connection discards deferred state and unblocks hydration", async () => {
  const receivedTypes: string[] = [];
  const setup = realtimeTestSetup({
    listener: ({ type }) => {
      receivedTypes.push(type);
    },
  });
  const stopConnection = setup.connection.stop.bind(setup.connection);
  disposals.unshift(stopConnection);
  const initialSocket = setup.sockets.at(-1);
  initialSocket?.open("original-instance");
  initialSocket?.receive({ sessions: [], type: "sessions" });
  const yielded = setup.connection.yieldToStateApplication();

  initialSocket?.close();

  await expect(yielded).resolves.toBe(false);
  setup.requestFrames.shift()?.();
  expect(receivedTypes).toEqual(["ready"]);
});

test("streaming tool updates do not invalidate the controlled new-session input", () => {
  const detail = largeRunningDetail();
  const { container, controller } = mountRealSessionPanel(detail);
  const prompt = container.querySelector("#session-prompt");
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError("Expected the new-session prompt textarea");
  }
  let draftReads = 0;
  const draft = controller.state.draft;
  Reflect.defineProperty(draft, "prompt", {
    configurable: true,
    get() {
      draftReads += 1;
      return "";
    },
  });
  draftReads = 0;

  const buffer = new RealtimeStreamBuffer();
  for (let sequence = 0; sequence < 40; sequence += 1) {
    buffer.queue({
      callId: "call-typing-profile",
      ...(sequence === 0
        ? { state: "preparing" as const }
        : sequence === 1
          ? { channel: "name" as const, content: "bash" }
          : sequence === 2
            ? { state: "running" as const }
            : { channel: "stdout" as const, content: "x" }),
      index: 0,
      sequence,
      sessionId: detail.id,
      streamId: "stream-typing-profile",
      type: "tool_stream",
    });
  }
  const batch = buffer.takeNext(40);
  if (batch === undefined) throw new TypeError("Expected buffered tool output");
  controller.applyStreamBatch(batch);
  const remaining = buffer.takeNext(40);
  if (remaining !== undefined) controller.applyStreamBatch(remaining);

  expect(controller.state.toolStreams).toEqual([
    {
      arguments: "",
      callId: "call-typing-profile",
      index: 0,
      name: "bash",
      sequence: 39,
      sessionId: detail.id,
      state: "running",
      stderr: "",
      stdout: "x".repeat(37),
      streamId: "stream-typing-profile",
    },
  ]);
  expect(draftReads).toBe(0);
  expect(prompt.value).toBe("");
});
