import { afterEach, expect, test } from "vitest";
import { createReactiveState } from "../reactive-state.ts";
import type { RealtimeClientEvent } from "../realtime-stream-buffer.ts";
import type { SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { SessionPendingInputs } from "../session-pending-client.tsx";
import { reconcilePendingInputs } from "../session-pending-input.ts";
import { initialSessionViewState } from "../session-state.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
import { mountTestView, queryTestElement } from "./dom-test-helpers.ts";
import { realtimeTestSetup } from "./realtime-client-test-setup.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { pendingInputFixture } from "./session-pending-fixtures.ts";

interface LatencyMeasure {
  acknowledgedAt: number | undefined;
  dispatchedAt: number;
  echoedAt: number | undefined;
  insertedAt: number | undefined;
  optimisticAt: number | undefined;
  renderedAt: number | undefined;
  respondedAt: number | undefined;
}

const cleanupTasks: (() => void)[] = [];

afterEach(function cleanLatencyView() {
  for (const dispose of cleanupTasks) dispose();
  cleanupTasks.length = 0;
  document.body.textContent = "";
});

function runningSessionState(): SessionViewState {
  const detail = Object.assign({}, TEST_SESSION_DETAIL, {
    status: "running" as const,
  });
  return Object.assign(initialSessionViewState(), {
    detail,
    followUp: "Measure every seam",
    selectedId: detail.id,
    sessions: Array.of(summaryFromDetail(detail)),
  });
}

function commandEnvelope(socket: { readonly sent: readonly string[] }): {
  readonly commandId: string;
  readonly payload: Readonly<Record<string, unknown>>;
} {
  const serialized = socket.sent.at(-1);
  if (serialized === undefined) throw new TypeError("Missing command envelope");
  const value: unknown = JSON.parse(serialized);
  if (
    typeof value !== "object" ||
    value === null ||
    !("commandId" in value) ||
    typeof value.commandId !== "string" ||
    !("payload" in value) ||
    typeof value.payload !== "object" ||
    value.payload === null
  ) {
    throw new TypeError("Invalid command envelope");
  }
  return {
    commandId: value.commandId,
    payload: { ...value.payload },
  };
}

function applySessionEvent(
  controller: SessionController,
  event: Parameters<SessionController["applyDetail"]>[0],
  measure: LatencyMeasure,
  now: () => number,
): void {
  measure.echoedAt = now();
  controller.applyDetail(event);
}

function pendingInputs(
  controller: SessionController,
): ReturnType<typeof reconcilePendingInputs> {
  return reconcilePendingInputs(
    controller.view().detail?.pendingInputs ?? [],
    controller.view().optimisticPendingInputs,
  );
}

function receiveBackgroundLoad(socket: {
  receive(value: unknown): void;
}): void {
  for (let session = 0; session < 6; session += 1) {
    for (let delta = 0; delta < 20; delta += 1) {
      socket.receive({
        content: "x",
        sessionId: `background-${String(session)}`,
        thinking: "",
        type: "session_delta",
      });
    }
  }
}

test("acknowledges a send locally without waiting for persistence, echo, or command response", async () => {
  const state = runningSessionState();
  const reactive = createReactiveState(state);
  const frames: (() => void)[] = [];
  let clock = 0;
  const now = (): number => clock;
  const measure: LatencyMeasure = {
    acknowledgedAt: undefined,
    dispatchedAt: now(),
    echoedAt: undefined,
    insertedAt: undefined,
    optimisticAt: undefined,
    renderedAt: undefined,
    respondedAt: undefined,
  };
  const receive: { current?: (event: RealtimeClientEvent) => void } = {};
  const setup = realtimeTestSetup({
    listener(event) {
      receive.current?.(event);
    },
    requestFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
  });
  const connection = setup.connection;
  const socket = setup.sockets[0];
  if (socket === undefined) throw new TypeError("Missing realtime socket");
  socket.open("latency-instance");
  const controller = new SessionController(reactive, undefined, null, {
    command: (operation, payload, idempotencyKey) =>
      connection.command(operation, payload, idempotencyKey),
  });
  receive.current = (event) => {
    if (event.type === "session") {
      applySessionEvent(controller, event.session, measure, now);
    }
  };
  const detail = state.detail;
  if (detail === undefined) throw new TypeError("Missing session detail");
  const ignorePendingAction = (): void => undefined;
  const pendingView = () => (
    <SessionPendingInputs
      inputs={pendingInputs(controller)}
      onCancel={ignorePendingAction}
      onRetry={ignorePendingAction}
    />
  );
  const container = mountTestView(pendingView, cleanupTasks);
  cleanupTasks.push(connection.stop.bind(connection));

  receiveBackgroundLoad(socket);
  expect(frames).toHaveLength(1);

  const submitted = controller.followUp();
  clock = 1;
  measure.optimisticAt = now();
  const pending = queryTestElement(container, "[data-pending-input-status]");
  measure.renderedAt = now();
  measure.acknowledgedAt = now();
  expect(pending.textContent).toContain("Measure every seam");

  const command = commandEnvelope(socket);
  clock = 25;
  measure.insertedAt = now();
  const optimistic = controller.state.optimisticPendingInputs[0];
  if (optimistic === undefined) throw new TypeError("Missing optimistic input");
  const authoritative = Object.assign({}, detail, {
    pendingInputs: [
      pendingInputFixture(optimistic.content, {
        clientRequestId: optimistic.clientRequestId,
        id: "pending-authoritative",
      }),
    ],
    updatedAt: detail.updatedAt + 1,
  });
  socket.receive({ session: authoritative, type: "session" });
  clock = 55;
  frames.at(-1)?.();
  expect(measure.echoedAt).toBe(55);
  expect(controller.state.detail?.pendingInputs[0]?.id).toBe(
    "pending-authoritative",
  );
  expect(controller.state.optimisticPendingInputs).toEqual([]);
  expect(container.textContent).not.toContain("Sending…");
  expect(container.textContent.match(/Measure every seam/gu)).toHaveLength(1);

  clock = 80;
  socket.receive({
    commandId: command.commandId,
    result: authoritative,
    type: "command_success",
  });
  measure.respondedAt = now();
  await submitted;

  expect(measure).toEqual({
    acknowledgedAt: 1,
    dispatchedAt: 0,
    echoedAt: 55,
    insertedAt: 25,
    optimisticAt: 1,
    renderedAt: 1,
    respondedAt: 80,
  });
  expect(container.textContent.match(/Measure every seam/gu)).toHaveLength(1);
});
