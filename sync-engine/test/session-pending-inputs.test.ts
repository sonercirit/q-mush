import { describe, expect, test } from "vitest";
import type { AgentImage } from "../../shared/agent-images.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  runningStore,
  SESSION_ID,
  testSessionInput,
} from "./session-store-fixtures.ts";

// cpd-ignore-start -- Store tests intentionally repeat complete queue payloads to verify each invariant.
describe("pending session input store", () => {
  test("does not replace an active runtime with a duplicate launch", async () => {
    const runtimes = new SessionRuntimes();
    let finishFirst: (() => void) | undefined;
    let runs = 0;

    expect(
      runtimes.launch(SESSION_ID, () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }),
    ).toBe(true);
    expect(
      runtimes.launch(SESSION_ID, () => {
        runs += 1;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(
      runtimes.schedule(SESSION_ID, () => {
        runs += 1;
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(
      runtimes.schedule(SESSION_ID, () => {
        runs += 1;
        return Promise.resolve();
      }),
    ).toBe(false);
    await Promise.resolve();
    expect(runs).toBe(1);

    finishFirst?.();
    await Bun.sleep(0);
    expect(runs).toBe(2);
  });

  test("persists bounded FIFO follow-ups with images and idempotency", () => {
    const { database, store } = runningStore();
    const queue = (
      clientRequestId: string,
      content: string,
      images: readonly AgentImage[] = [],
    ) =>
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        { clientRequestId, content, images, kind: "follow_up" },
        TEST_NOW + 2,
      );

    expect(queue("follow-1", "First", [TEST_AGENT_IMAGE]).status).toBe(
      "accepted",
    );
    expect(queue("follow-2", "Second").status).toBe("accepted");
    expect(queue("follow-1", "First", [TEST_AGENT_IMAGE])).toMatchObject({
      status: "duplicate",
    });
    expect(queue("follow-1", "Changed").status).toBe("conflict");
    expect(store.get(TEST_USER_ID, SESSION_ID)?.pendingInputs).toMatchObject([
      { content: "First", images: [TEST_AGENT_IMAGE], kind: "follow_up" },
      { content: "Second", images: [], kind: "follow_up" },
    ]);

    for (let index = 2; index < 8; index += 1) {
      expect(queue(`follow-${String(index + 1)}`, String(index))).toMatchObject(
        {
          status: "accepted",
        },
      );
    }
    expect(queue("follow-9", "Overflow").status).toBe("full");
    database.$client.close();
  });

  test("orders equal-timestamp pending inputs by their durable sequence", () => {
    const { database, store } = runningStore();
    const requestIds = ["request-z", "request-a", "request-m"];

    for (const clientRequestId of requestIds) {
      expect(
        store.enqueuePendingInput(
          TEST_USER_ID,
          SESSION_ID,
          {
            clientRequestId,
            content: clientRequestId,
            images: [],
            kind: "follow_up",
          },
          TEST_NOW + 2,
        ).status,
      ).toBe("accepted");
    }

    expect(
      store
        .get(TEST_USER_ID, SESSION_ID)
        ?.pendingInputs.map(({ content }) => content),
    ).toEqual(requestIds);
    database.$client.close();
  });

  test("rejects a request ID reused across sessions", () => {
    const { database, store } = runningStore();
    const another = store.create(testSessionInput(), TEST_NOW + 2);

    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        {
          clientRequestId: "shared-request",
          content: "First session",
          images: [],
          kind: "follow_up",
        },
        TEST_NOW + 3,
      ).status,
    ).toBe("accepted");
    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        another.id,
        {
          clientRequestId: "shared-request",
          content: "First session",
          images: [],
          kind: "follow_up",
        },
        TEST_NOW + 4,
      ).status,
    ).toBe("conflict");
    database.$client.close();
  });

  test("claims steering FIFO exactly once and keeps tool boundaries intact", () => {
    const { database, store } = runningStore();

    for (const { clientRequestId, content } of [
      { clientRequestId: "steer-1", content: "First steer" },
      { clientRequestId: "steer-2", content: "Second steer" },
    ]) {
      expect(
        store.enqueuePendingInput(
          TEST_USER_ID,
          SESSION_ID,
          {
            clientRequestId,
            content,
            images: content === "First steer" ? [TEST_AGENT_IMAGE] : [],
            kind: "steer",
          },
          TEST_NOW + 2,
        ).status,
      ).toBe("accepted");
    }

    expect(store.takeSteeringInputs(SESSION_ID, TEST_NOW + 3)).toEqual([
      {
        content: "First steer",
        images: [TEST_AGENT_IMAGE],
        role: "user",
      },
      { content: "Second steer", role: "user" },
    ]);
    expect(store.takeSteeringInputs(SESSION_ID, TEST_NOW + 4)).toEqual([]);
    expect(
      store.get(TEST_USER_ID, SESSION_ID)?.messages.slice(-2),
    ).toMatchObject([
      { content: "First steer", images: [TEST_AGENT_IMAGE], role: "user" },
      { content: "Second steer", images: [], role: "user" },
    ]);
    expect(store.get(TEST_USER_ID, SESSION_ID)?.pendingInputs).toEqual([]);
    database.$client.close();
  });

  test("does not consume steering from behind an earlier follow-up", () => {
    const { database, store } = runningStore();
    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        {
          clientRequestId: "earlier-follow-up",
          content: "Do this next",
          images: [],
          kind: "follow_up",
        },
        TEST_NOW + 2,
      ).status,
    ).toBe("accepted");
    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        {
          clientRequestId: "later-steer",
          content: "Late steering",
          images: [],
          kind: "steer",
        },
        TEST_NOW + 3,
      ).status,
    ).toBe("accepted");

    expect(store.takeSteeringInputs(SESSION_ID, TEST_NOW + 4)).toEqual([]);
    expect(store.get(TEST_USER_ID, SESSION_ID)?.pendingInputs).toMatchObject([
      { content: "Do this next", kind: "follow_up" },
      { content: "Late steering", kind: "steer" },
    ]);
    database.$client.close();
  });

  test("promotes one follow-up only at the idle boundary", () => {
    const { database, store } = runningStore();
    for (const { clientRequestId, content } of [
      { clientRequestId: "follow-1", content: "First follow-up" },
      { clientRequestId: "follow-2", content: "Second follow-up" },
    ]) {
      expect(
        store.enqueuePendingInput(
          TEST_USER_ID,
          SESSION_ID,
          { clientRequestId, content, images: [], kind: "follow_up" },
          TEST_NOW + 2,
        ).status,
      ).toBe("accepted");
    }

    const next = store.settleNormalBoundary(SESSION_ID, TEST_NOW + 3);

    expect(next).toMatchObject({ status: "queued" });
    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      pendingInputs: [{ content: "Second follow-up", kind: "follow_up" }],
      status: "queued",
    });
    expect(store.conversation(SESSION_ID).at(-1)).toEqual({
      content: "First follow-up",
      role: "user",
    });
    database.$client.close();
  });

  test("recognizes steering that owns the final normal boundary", () => {
    const { database, store } = runningStore();
    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        {
          clientRequestId: "boundary-steer",
          content: "Continue before going idle",
          images: [],
          kind: "steer",
        },
        TEST_NOW + 2,
      ).status,
    ).toBe("accepted");

    expect(store.settleNormalBoundary(SESSION_ID, TEST_NOW + 3)).toEqual({
      status: "running",
      userId: TEST_USER_ID,
    });
    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      pendingInputs: [{ content: "Continue before going idle", kind: "steer" }],
      status: "running",
    });
    database.$client.close();
  });

  test("keeps steering queued when an earlier follow-up owns the idle boundary", () => {
    const { database, store } = runningStore();
    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        {
          clientRequestId: "follow-before-steer",
          content: "Next turn",
          images: [],
          kind: "follow_up",
        },
        TEST_NOW + 2,
      ).status,
    ).toBe("accepted");
    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        {
          clientRequestId: "late-steer",
          content: "Arrived at the boundary",
          images: [],
          kind: "steer",
        },
        TEST_NOW + 3,
      ).status,
    ).toBe("accepted");

    expect(store.settleNormalBoundary(SESSION_ID, TEST_NOW + 4)).toMatchObject({
      status: "queued",
    });
    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      pendingInputs: [{ content: "Arrived at the boundary", kind: "steer" }],
      status: "queued",
    });
    database.$client.close();
  });

  test("recovers a leading follow-up as queued work after interruption", () => {
    const { database, store } = runningStore();
    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        {
          clientRequestId: "restart-follow-up",
          content: "Run this after restart",
          images: [],
          kind: "follow_up",
        },
        TEST_NOW + 2,
      ).status,
    ).toBe("accepted");

    store.recoverInterrupted(TEST_NOW + 3);

    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      messages: [
        { role: "user" },
        { role: "error" },
        { content: "Run this after restart", role: "user" },
      ],
      pendingInputs: [],
      status: "queued",
    });
    expect(store.conversation(SESSION_ID).at(-1)).toEqual({
      content: "Run this after restart",
      role: "user",
    });
    expect(store.queuedSessionOwnerIds()).toEqual([TEST_USER_ID]);
    database.$client.close();
  });

  test("fails interrupted steering so it is resumed explicitly at a safe boundary", () => {
    const { database, store } = runningStore();
    expect(
      store.enqueuePendingInput(
        TEST_USER_ID,
        SESSION_ID,
        {
          clientRequestId: "restart-steer",
          content: "Apply this only when resumed",
          images: [],
          kind: "steer",
        },
        TEST_NOW + 2,
      ).status,
    ).toBe("accepted");

    store.recoverInterrupted(TEST_NOW + 3);

    expect(store.get(TEST_USER_ID, SESSION_ID)).toMatchObject({
      pendingInputs: [
        { content: "Apply this only when resumed", kind: "steer" },
      ],
      status: "failed",
    });
    expect(store.queuedSessionOwnerIds()).toEqual([]);
    database.$client.close();
  });

  test("retains pending inputs through stop and failure", () => {
    for (const finish of ["stop", "fail"] as const) {
      const { database, store } = runningStore();
      expect(
        store.enqueuePendingInput(
          TEST_USER_ID,
          SESSION_ID,
          {
            clientRequestId: `pending-${finish}`,
            content: "Keep me queued",
            images: [TEST_AGENT_IMAGE],
            kind: "follow_up",
          },
          TEST_NOW + 2,
        ).status,
      ).toBe("accepted");

      if (finish === "stop") {
        expect(store.stop(TEST_USER_ID, SESSION_ID, TEST_NOW + 3)).toBe(true);
      } else {
        expect(store.mark(SESSION_ID, "failed", TEST_NOW + 3)).toBe(true);
      }

      expect(store.get(TEST_USER_ID, SESSION_ID)?.pendingInputs).toMatchObject([
        {
          content: "Keep me queued",
          images: [TEST_AGENT_IMAGE],
          kind: "follow_up",
        },
      ]);
      database.$client.close();
    }
  });
});
// cpd-ignore-end
