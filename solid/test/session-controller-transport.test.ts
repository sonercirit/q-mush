import { expect, test, vi } from "vitest";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { summaryFromDetail } from "../../solid/session-codec.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import type { SessionCommandTransport } from "../../solid/session-transport.ts";
import type { SessionCommandCall } from "./session-command-call.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function createRecordedTransport(
  results: Readonly<Record<string, unknown>>,
): SessionCommandTransport & { readonly calls: SessionCommandCall[] } {
  const calls: SessionCommandCall[] = [];
  return {
    calls,
    command: (operation, payload) => {
      calls.push({ operation, payload });
      return Promise.resolve(results[operation]);
    },
  };
}

function sessionState(
  changes: Partial<SessionViewState> = {},
): SessionViewState {
  return { ...initialSessionViewState(), ...changes };
}

function selectedSessionState(): SessionViewState {
  return sessionState({
    detail: TEST_SESSION_DETAIL,
    selectedId: TEST_SESSION_DETAIL.id,
    sessions: [summaryFromDetail(TEST_SESSION_DETAIL)],
  });
}

function sessionReadCall(sessionId: string): SessionCommandCall {
  return {
    operation: SESSION_REALTIME_OPERATIONS.read,
    payload: { sessionId },
  };
}

function subscriptionCall(): SessionCommandCall {
  return { operation: SESSION_REALTIME_OPERATIONS.subscribe, payload: {} };
}

function summaryResult(): {
  readonly sessions: ReturnType<typeof summaryFromDetail>[];
} {
  return { sessions: [summaryFromDetail(TEST_SESSION_DETAIL)] };
}

function sessionSubscriptions(calls: readonly SessionCommandCall[]): number {
  return calls.filter(
    ({ operation }) => operation === SESSION_REALTIME_OPERATIONS.subscribe,
  ).length;
}

function reconnectAndExpectSubscriptions(
  transport: ControlledTransport,
  expected: number,
): void {
  transport.reconnect();
  expect(sessionSubscriptions(transport.calls)).toBe(expected);
}

async function expectSubscriptionCount(
  transport: ControlledTransport,
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(sessionSubscriptions(transport.calls)).toBe(count);
  });
}

async function expectReadCall(
  transport: ControlledTransport,
  sessionId = TEST_SESSION_DETAIL.id,
): Promise<void> {
  await vi.waitFor(() => {
    expect(transport.calls.at(-1)).toEqual(sessionReadCall(sessionId));
  });
}

async function finishDetailRead(
  transport: ControlledTransport,
  controller: SessionController,
  index: number,
  detail = TEST_SESSION_DETAIL,
): Promise<void> {
  resolveDetailRead(transport, index, detail);
  await vi.waitFor(() => {
    expect(controller.state.loadingDetail).toBe(false);
  });
}

async function startRehydration(transport: ControlledTransport): Promise<void> {
  transport.reconnect();
  transport.resolve(0, summaryResult());
  await expectReadCall(transport);
}

function resolveDetailRead(
  transport: ControlledTransport,
  index: number,
  detail = TEST_SESSION_DETAIL,
): void {
  transport.resolve(index, { session: detail });
}

async function startControlledRehydration(): Promise<
  readonly [ControlledTransport, SessionController]
> {
  const [transport, controller] = controlledController();
  await startRehydration(transport);
  return [transport, controller];
}

async function settleRehydration(
  transport: ControlledTransport,
  controller: SessionController,
  summaryIndex: number,
  detailIndex: number,
  detail = TEST_SESSION_DETAIL,
): Promise<void> {
  transport.resolve(summaryIndex, summaryResult());
  await expectReadCall(transport);
  await finishDetailRead(transport, controller, detailIndex, detail);
}

function sessionMutationCall(operation: string): SessionCommandCall {
  return { operation, payload: { sessionId: TEST_SESSION_DETAIL.id } };
}

function controllerWithTransport(
  transport: SessionCommandTransport,
  state = selectedSessionState(),
): SessionController {
  return new SessionController(
    createReactiveState<SessionViewState>(state),
    undefined,
    null,
    transport,
  );
}

function controlledController(
  state = selectedSessionState(),
): readonly [ControlledTransport, SessionController] {
  const transport = new ControlledTransport();
  return [transport, controllerWithTransport(transport, state)];
}

class ControlledTransport implements SessionCommandTransport {
  readonly calls: SessionCommandCall[] = [];
  readonly #resolvers: ((value: unknown) => void)[] = [];

  command(operation: string, payload: Readonly<Record<string, unknown>>) {
    this.calls.push({ operation, payload });
    return new Promise<unknown>((resolve) => {
      this.#resolvers.push(resolve);
    });
  }

  reconnect(): void {
    this.#reconnectListener?.();
  }

  #reconnectListener: (() => void) | undefined;

  onReconnect(listener: () => void): () => void {
    this.#reconnectListener = listener;
    return () => {
      this.#reconnectListener = undefined;
    };
  }

  resolve(index: number, value: unknown): void {
    this.#resolvers[index]?.(value);
  }
}

test("sends create and follow-up image payloads through realtime commands", async () => {
  const image = {
    data: "aGVsbG8=",
    mediaType: "image/png" as const,
    name: "screen.png",
  };
  const transport = createRecordedTransport({
    [SESSION_REALTIME_OPERATIONS.create]: TEST_SESSION_DETAIL,
    [SESSION_REALTIME_OPERATIONS.models]: {
      defaultModel: TEST_SESSION_DETAIL.model,
      models: [
        Object.freeze({
          contextWindow: TEST_SESSION_DETAIL.maxContextTokens,
          id: TEST_SESSION_DETAIL.model,
          inputModalities: ["text", "image"],
          label: "Test model",
          outputModalities: ["text"],
          pricing: null,
          reasoningEfforts: [],
        }),
      ],
    },
    [SESSION_REALTIME_OPERATIONS.send]: {
      ...TEST_SESSION_DETAIL,
      status: "queued",
    },
  });
  const reactive = createReactiveState<SessionViewState>(
    sessionState({
      draft: {
        ...initialSessionViewState().draft,
        credential: "openai:credential-1",
        images: [image],
        model: TEST_SESSION_DETAIL.model,
        prompt: "Inspect this",
        runnerId: TEST_SESSION_DETAIL.runnerId,
        workingDirectory: TEST_SESSION_DETAIL.workingDirectory,
      },
    }),
  );
  const controller = new SessionController(
    reactive,
    undefined,
    null,
    transport,
  );

  await controller.create();
  expect(
    transport.calls.find(({ operation }) => operation === "sessions.create"),
  ).toMatchObject({
    payload: { images: [image], prompt: "Inspect this" },
  });

  reactive.setState({
    ...reactive.state(),
    followUp: "Review it",
    followUpImages: [image],
  });
  await controller.send();
  expect(transport.calls.at(-1)).toEqual(
    Object.freeze({
      operation: SESSION_REALTIME_OPERATIONS.send,
      payload: {
        images: [image],
        prompt: "Review it",
        sessionId: TEST_SESSION_DETAIL.id,
      },
    }),
  );
});

test("sends resumable and active session mutations through realtime commands", async () => {
  const transport = createRecordedTransport({
    [SESSION_REALTIME_OPERATIONS.compact]: TEST_SESSION_DETAIL,
    [SESSION_REALTIME_OPERATIONS.continue]: TEST_SESSION_DETAIL,
    [SESSION_REALTIME_OPERATIONS.setAutoCompaction]: TEST_SESSION_DETAIL,
    [SESSION_REALTIME_OPERATIONS.stop]: TEST_SESSION_DETAIL,
  });
  const resumableController = controllerWithTransport(transport);

  await resumableController.continueSession();
  await resumableController.compact();
  await resumableController.toggleAutoCompact(false);

  const activeController = controllerWithTransport(transport, {
    ...selectedSessionState(),
    detail: { ...TEST_SESSION_DETAIL, status: "running" },
  });
  await activeController.stop();

  expect(transport.calls).toEqual([
    sessionMutationCall(SESSION_REALTIME_OPERATIONS.continue),
    sessionMutationCall(SESSION_REALTIME_OPERATIONS.compact),
    {
      operation: SESSION_REALTIME_OPERATIONS.setAutoCompaction,
      payload: { autoCompact: false, sessionId: TEST_SESSION_DETAIL.id },
    },
    sessionMutationCall(SESSION_REALTIME_OPERATIONS.stop),
  ]);
});

test("does not let an initial socket snapshot supersede command hydration", async () => {
  const [transport, controller] = controlledController(
    sessionState({ sessions: undefined }),
  );

  const loading = controller.load();
  expect(transport.calls).toEqual([subscriptionCall()]);
  controller.applyRealtime([summaryFromDetail(TEST_SESSION_DETAIL)]);
  expect(transport.calls).toHaveLength(1);

  transport.resolve(0, summaryResult());
  await expectReadCall(transport);
  transport.resolve(1, { session: TEST_SESSION_DETAIL });
  await loading;

  expect(controller.state).toMatchObject({
    loadingDetail: false,
    selectedId: TEST_SESSION_DETAIL.id,
  });
});

test("defers reconnect rehydration until an outstanding mutation settles", async () => {
  const [transport, controller] = controlledController({
    ...selectedSessionState(),
    followUp: "Finish this",
  });

  const sending = controller.send();
  expect(controller.state.sending).toBe(true);
  expect(transport.calls).toEqual([
    Object.freeze({
      operation: SESSION_REALTIME_OPERATIONS.send,
      payload: {
        prompt: "Finish this",
        sessionId: TEST_SESSION_DETAIL.id,
      },
    }),
  ]);

  reconnectAndExpectSubscriptions(transport, 0);

  const queued = { ...TEST_SESSION_DETAIL, status: "queued" as const };
  transport.resolve(0, queued);
  await sending;
  await vi.waitFor(() => {
    expect(transport.calls).toContainEqual(subscriptionCall());
  });
  expect(controller.state.sending).toBe(false);

  await settleRehydration(transport, controller, 1, 2);
});

test("reconnect rehydrates the selected detail without applying stale work", async () => {
  const [transport, controller] = await startControlledRehydration();
  const rehydrated = { ...TEST_SESSION_DETAIL, title: "Rehydrated" };
  await finishDetailRead(transport, controller, 1, rehydrated);
  expect(controller.state.detail?.title).toBe("Rehydrated");
});

test("coalesces reconnects that arrive during an active rehydration", async () => {
  const [transport, controller] = await startControlledRehydration();

  reconnectAndExpectSubscriptions(transport, 1);

  resolveDetailRead(transport, 1);
  await expectSubscriptionCount(transport, 2);

  await settleRehydration(transport, controller, 2, 3);
});

test("rapid session switching never applies a stale detail acknowledgement", async () => {
  const transport = new ControlledTransport();
  const secondSession = { ...TEST_SESSION_DETAIL, id: "session-2" };
  const controller = controllerWithTransport(
    transport,
    sessionState({
      sessions: [
        summaryFromDetail(TEST_SESSION_DETAIL),
        summaryFromDetail(secondSession),
      ],
    }),
  );

  const first = controller.select(TEST_SESSION_DETAIL.id);
  const second = controller.select("session-2");
  expect({
    loading: controller.state.loadingDetail,
    calls: transport.calls,
  }).toMatchObject({
    loading: true,
    calls: [
      sessionReadCall(TEST_SESSION_DETAIL.id),
      sessionReadCall("session-2"),
    ],
  });

  transport.resolve(1, { session: { ...secondSession, title: "Second" } });
  await second;
  transport.resolve(0, { session: TEST_SESSION_DETAIL });
  await first;

  expect(controller.state.selectedId).toBe("session-2");
  expect(controller.state.detail).toMatchObject({
    id: "session-2",
    title: "Second",
  });
  expect(controller.state.loadingDetail).toBe(false);
});
