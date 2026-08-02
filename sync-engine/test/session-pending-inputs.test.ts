import { and, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import type { AgentImage } from "../../shared/agent-images.ts";
import { agentPendingInputs } from "../../shared/database/schema.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionFinisher } from "../session-finisher.ts";
import {
  cancelPendingInput,
  enqueuePendingInput,
  hasPendingSteeringInput,
} from "../session-pending-inputs.ts";
import { SessionRuntimes } from "../session-runtime.ts";
import { waitForSessionSteeringInput } from "../session-steering-wakeup.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

const OTHER_USER_ID = "018bcfe5-6800-7000-8000-000000000099";

function runningStore() {
  const setup = createStore();
  const detail = createTestSession(setup.store);
  expect(
    setup.store.transitionRuntime(
      detail.id,
      "running",
      TEST_NOW + 1,
      detail.generation,
    ),
  ).toBe(true);
  return { ...setup, detail };
}

function pendingInput(
  clientRequestId: string,
  content: string,
  kind: "follow_up" | "steer" = "follow_up",
  images: readonly AgentImage[] = [],
) {
  return { clientRequestId, content, images, kind };
}

function enqueueForUser(
  setup: ReturnType<typeof runningStore>,
  userId: string,
  clientRequestId: string,
  content: string,
  now: number,
  kind: "follow_up" | "steer" = "follow_up",
) {
  return enqueuePendingInput({
    database: setup.database,
    generateId: setup.generateId,
    input: pendingInput(clientRequestId, content, kind),
    now,
    sessionId: setup.detail.id,
    userId,
  });
}

function enqueueInput(
  setup: ReturnType<typeof runningStore>,
  clientRequestId: string,
  content: string,
  kind: "follow_up" | "steer" = "follow_up",
  now = TEST_NOW + 2,
) {
  return enqueueForUser(
    setup,
    TEST_USER_ID,
    clientRequestId,
    content,
    now,
    kind,
  );
}

function cancelInput(
  setup: ReturnType<typeof runningStore>,
  userId: string,
  inputId: string,
  now: number,
) {
  return cancelPendingInput({
    database: setup.database,
    inputId,
    now,
    sessionId: setup.detail.id,
    userId,
  });
}

function steeringIsPending(setup: ReturnType<typeof runningStore>): boolean {
  return hasPendingSteeringInput(pendingInputs(setup) ?? []);
}

function pendingInputs(setup: ReturnType<typeof runningStore>) {
  return setup.store.get(TEST_USER_ID, setup.detail.id)?.pendingInputs;
}

function expectSteeringTaken(setup: ReturnType<typeof runningStore>): void {
  expect(setup.store.takeSteeringInputs(setup.detail.id, TEST_NOW + 3)).toEqual(
    [{ content: "Change direction", role: "user" }],
  );
}

function closeRunningStore(setup: ReturnType<typeof runningStore>): void {
  setup.database.$client.close();
}

function failRunningStore(setup: ReturnType<typeof runningStore>): void {
  setup.store.transitionRuntime(
    setup.detail.id,
    "failed",
    TEST_NOW + 3,
    setup.detail.generation,
  );
}

function queueRunningStore(
  setup: ReturnType<typeof runningStore>,
  prompt?: Readonly<{ content: string; images: [] }>,
) {
  return setup.store.queue(TEST_USER_ID, setup.detail.id, TEST_NOW + 4, prompt);
}

function expectSessionDetail(
  setup: ReturnType<typeof runningStore>,
  expected: object,
): void {
  expect(setup.store.get(TEST_USER_ID, setup.detail.id)).toMatchObject(
    expected,
  );
}

function expectSuccessorInitiatingMessage(
  detail: AgentSessionDetail | undefined,
  boundaryIndex: number,
  successorIndex: number,
): void {
  const [closingTurn, successorTurn] = detail?.turns ?? [];
  const boundaryMessage = detail?.messages[boundaryIndex];
  const successorMessage = detail?.messages[successorIndex];
  expect(closingTurn?.boundaryMessageId).toBe(boundaryMessage?.id);
  expect(successorMessage?.turnId).toBe(successorTurn?.id);
}

function expectQueuedBoundary(
  setup: ReturnType<typeof runningStore>,
  now: number,
): void {
  expect(
    setup.store.settleNormalBoundary(
      setup.detail.id,
      now,
      setup.detail.generation,
    ),
  ).toEqual({ status: "queued", userId: TEST_USER_ID });
}

describe("durable pending session inputs", () => {
  test("persists more than eight FIFO inputs with owner-scoped idempotency", () => {
    const setup = runningStore();
    const inputCount = 20;
    const statuses = Array.from({ length: inputCount }, (_, index) =>
      enqueueInput(
        setup,
        `request-${String(index)}`,
        `Follow ${String(index)}`,
        index % 2 === 0 ? "follow_up" : "steer",
        TEST_NOW + 2 + index,
      ),
    ).map(({ status }) => status);
    expect(statuses).toEqual(
      Array.from({ length: inputCount }, () => "accepted"),
    );
    expect(
      enqueueForUser(
        setup,
        TEST_USER_ID,
        "request-0",
        "Follow 0",
        TEST_NOW + 30,
      ),
    ).toMatchObject({ status: "duplicate" });

    expect(
      enqueueForUser(
        setup,
        TEST_USER_ID,
        "request-0",
        "Changed",
        TEST_NOW + 31,
      ),
    ).toEqual({ status: "conflict" });
    expect(
      setup.database
        .select({ sequence: agentPendingInputs.sequence })
        .from(agentPendingInputs)
        .where(eq(agentPendingInputs.sessionId, setup.detail.id))
        .all()
        .map(({ sequence }) => sequence),
    ).toEqual(Array.from({ length: inputCount }, (_, index) => index + 1));
    closeRunningStore(setup);
  });

  test("cancels an unconsumed input idempotently and returns its draft", () => {
    const setup = runningStore();
    const accepted = setup.store.enqueuePendingInput(
      TEST_USER_ID,
      setup.detail.id,
      pendingInput("cancel-request", "Edit this next", "follow_up", [
        TEST_AGENT_IMAGE,
      ]),
      TEST_NOW + 2,
    );
    expect(accepted).toMatchObject({ status: "accepted" });
    if (!("input" in accepted)) {
      throw new Error("Cancellation setup failed");
    }

    expect(
      cancelInput(setup, TEST_USER_ID, accepted.input.id, TEST_NOW + 3),
    ).toEqual({ input: accepted.input, status: "cancelled" });
    expectSessionDetail(setup, { pendingInputs: [] });
    expect(
      cancelInput(setup, TEST_USER_ID, accepted.input.id, TEST_NOW + 4),
    ).toEqual({ input: accepted.input, status: "already_cancelled" });
    closeRunningStore(setup);
  });

  test("guards cancellation by owner, state, and consumption", () => {
    const owned = runningStore();
    const accepted = enqueueInput(owned, "guarded-cancel", "Keep guarded");
    if (!("input" in accepted)) {
      throw new Error("The pending input was not accepted");
    }
    expect(
      cancelInput(owned, OTHER_USER_ID, accepted.input.id, TEST_NOW + 3),
    ).toEqual({ status: "not_found" });
    failRunningStore(owned);
    expect(
      cancelInput(owned, TEST_USER_ID, accepted.input.id, TEST_NOW + 4),
    ).toEqual({ status: "invalid_state" });
    closeRunningStore(owned);

    const consumed = runningStore();
    const promoted = enqueueInput(
      consumed,
      "consumed-cancel",
      "Already promoted",
    );
    if (!("input" in promoted)) {
      throw new Error("The pending input was not accepted");
    }
    expectQueuedBoundary(consumed, TEST_NOW + 3);
    expect(
      cancelInput(consumed, TEST_USER_ID, promoted.input.id, TEST_NOW + 4),
    ).toEqual({ status: "consumed" });
    closeRunningStore(consumed);
  });

  test("keeps follow-up and steering state gates", () => {
    const setup = runningStore();
    failRunningStore(setup);

    expect(
      enqueueInput(
        setup,
        "failed-follow-up",
        "Do not follow up",
        "follow_up",
        TEST_NOW + 4,
      ),
    ).toEqual({ status: "invalid_state" });
    expect(
      enqueueInput(
        setup,
        "failed-steer",
        "Do not steer",
        "steer",
        TEST_NOW + 5,
      ),
    ).toEqual({ status: "invalid_state" });
    closeRunningStore(setup);
  });

  test("does not enumerate another owner's session", () => {
    const setup = runningStore();
    expect(
      enqueueForUser(
        setup,
        OTHER_USER_ID,
        "private-request",
        "Probe",
        TEST_NOW + 2,
      ),
    ).toEqual({ status: "not_found" });
    closeRunningStore(setup);
  });

  test("signals newly enqueued steering without consuming it", async () => {
    const setup = runningStore();
    const waiting = waitForSessionSteeringInput(
      setup.detail.id,
      new AbortController().signal,
    );

    enqueueInput(setup, "new-steer", "Wake up", "steer");

    await expect(waiting).resolves.toBeUndefined();
    expect(steeringIsPending(setup)).toBe(true);
    closeRunningStore(setup);
  });

  test("peeks at steering behind follow-up without consuming either input", () => {
    const setup = runningStore();
    enqueueInput(setup, "follow", "Do this next", "follow_up");
    enqueueInput(setup, "steer", "Change direction", "steer", TEST_NOW + 3);

    expect(steeringIsPending(setup)).toBe(true);
    const pending = pendingInputs(setup);
    expect(pending).toMatchObject([
      { content: "Do this next", kind: "follow_up" },
      { content: "Change direction", kind: "steer" },
    ]);

    closeRunningStore(setup);
  });

  test("consumes one steering input exactly once", () => {
    const setup = runningStore();
    enqueueInput(setup, "steer", "Change direction", "steer");

    expect(steeringIsPending(setup)).toBe(true);
    expect(pendingInputs(setup)?.[0]?.kind).toBe("steer");
    expectSteeringTaken(setup);
    expect(
      setup.store.takeSteeringInputs(setup.detail.id, TEST_NOW + 4),
    ).toEqual([]);
    expect(steeringIsPending(setup)).toBe(false);
    expect(pendingInputs(setup)).toEqual([]);

    closeRunningStore(setup);
  });

  test("consumes steering at a safe boundary and promotes one follow-up terminally", () => {
    const setup = runningStore();
    for (const [clientRequestId, content, kind] of [
      ["steer", "Change direction", "steer"],
      ["follow-1", "Next turn", "follow_up"],
      ["follow-2", "Later turn", "follow_up"],
    ] as const) {
      expect(enqueueInput(setup, clientRequestId, content, kind)).toMatchObject(
        { status: "accepted" },
      );
    }
    expectSteeringTaken(setup);
    expectQueuedBoundary(setup, TEST_NOW + 4);
    const stored = setup.database
      .select({ isDeleted: agentPendingInputs.isDeleted })
      .from(agentPendingInputs)
      .where(
        and(
          eq(agentPendingInputs.sessionId, setup.detail.id),
          eq(agentPendingInputs.isDeleted, false),
        ),
      )
      .all();
    expect(stored).toHaveLength(1);
    const detail = setup.store.get(TEST_USER_ID, setup.detail.id);
    expect(
      detail?.messages.map(({ content, role }) => ({ content, role })),
    ).toEqual([
      {
        content: "Inspect the repository\nand make it shine",
        role: "user",
      },
      { content: "Change direction", role: "user" },
      { content: "Next turn", role: "user" },
    ]);
    expect(detail).toMatchObject({
      pendingInputs: [{ content: "Later turn", kind: "follow_up" }],
      status: "queued",
    });
    const steeringMessage = detail?.messages[1];
    expectSuccessorInitiatingMessage(detail, 1, 2);
    expect(steeringMessage?.turnId).toBe(detail?.turns?.[0]?.id);
    expect(detail?.turns?.[1]?.boundaryMessageId).toBeNull();

    closeRunningStore(setup);
  });

  test("queues steering that arrives after the final model boundary", () => {
    const setup = runningStore();
    enqueueInput(setup, "late-steer", "Check the late constraint", "steer");

    expectQueuedBoundary(setup, TEST_NOW + 3);
    expectSessionDetail(setup, {
      messages: [
        { role: "user" },
        { content: "Check the late constraint", role: "user" },
      ],
      pendingInputs: [],
      status: "queued",
    });
    expectSuccessorInitiatingMessage(
      setup.store.get(TEST_USER_ID, setup.detail.id),
      0,
      1,
    );

    closeRunningStore(setup);
  });

  test.each([
    ["follow_up", "retained follow-up"],
    ["steer", "retained steering"],
  ] as const)(
    "promotes %s when a failed session resumes",
    (kind, clientRequestId) => {
      const setup = runningStore();
      enqueueInput(
        setup,
        clientRequestId,
        "Resume with this instruction",
        kind,
      );
      failRunningStore(setup);

      expect(queueRunningStore(setup)).toMatchObject({
        detail: {
          messages: [
            { role: "user" },
            { content: "Resume with this instruction", role: "user" },
          ],
          pendingInputs: [],
          status: "queued",
        },
        status: "queued",
      });
      closeRunningStore(setup);
    },
  );

  test("rejects a new resume prompt while durable input is pending", () => {
    const setup = runningStore();

    enqueueInput(setup, "retained-conflict", "Already pending");
    failRunningStore(setup);

    expect(
      queueRunningStore(setup, {
        content: "Ambiguous new prompt",
        images: [],
      }),
    ).toEqual({ status: "pending_input_conflict" });

    expectSessionDetail(setup, {
      pendingInputs: [{ content: "Already pending" }],
      status: "failed",
    });
    closeRunningStore(setup);
  });

  test("relaunches a terminal follow-up only after its runtime clears", async () => {
    const setup = runningStore();
    enqueueInput(setup, "post-runtime-follow-up", "Run after settlement");
    const runtimes = new SessionRuntimes();
    const launchStates: boolean[] = [];
    const finisher = new SessionFinisher({
      actions: { finished: vi.fn(), stopChildren: vi.fn() },
      launchQueued: () => {
        launchStates.push(runtimes.active(setup.detail.id));
      },
      notify: vi.fn(),
      now: () => TEST_NOW + 3,
      settled: (sessionId) => runtimes.cleared(sessionId),
      store: setup.store,
    });
    let release: (() => void) | undefined;
    expect(
      runtimes.launch(
        setup.detail.id,
        setup.detail.runnerId,
        setup.detail.generation,
        async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          finisher.finish(setup.detail, TEST_USER_ID);
        },
      ),
    ).toBe(true);

    release?.();
    await runtimes.settled(setup.detail.id);
    await vi.waitFor(() => {
      expect(launchStates).toEqual([false]);
    });
    closeRunningStore(setup);
  });

  test("retains pending work on failure", () => {
    const setup = runningStore();
    enqueueInput(setup, "retained", "Keep this");
    failRunningStore(setup);
    expect(pendingInputs(setup)).toMatchObject([{ content: "Keep this" }]);
    closeRunningStore(setup);
  });
});
