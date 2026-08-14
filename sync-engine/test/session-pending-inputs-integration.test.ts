import { describe, expect, test, vi } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { readSessionPendingInputCommand } from "../session-pending-input-request.ts";
import { launchQueuedSessions } from "../session-queued-launcher.ts";
import { executeSessionRealtimeCommand } from "../session-realtime-commands.ts";
import { createTestProviderCredential } from "./authenticated-integration-test-helpers.ts";
import { userRealtimeCommand } from "./realtime-command-fixtures.ts";
import {
  REALTIME_TEST_SESSION_DETAIL,
  realtimeTestPendingInput,
  realtimeTestSessionCommands,
} from "./realtime-session-fixture.ts";

const USER: AuthenticatedUser = {
  email: "mush@example.com",
  id: "user-1",
  name: "Mush",
};

describe("pending-input realtime integration", () => {
  test("parses the durable command payload", () => {
    expect(
      readSessionPendingInputCommand({
        clientRequestId: "request-1",
        kind: "follow_up",
        prompt: "  Continue  ",
        sessionId: "session-1",
      }),
    ).toEqual({
      attachments: [],
      clientRequestId: "request-1",
      images: [],
      kind: "follow_up",
      prompt: "Continue",
      sessionId: "session-1",
    });
  });

  test("dispatches follow-up and steering over authenticated realtime", async () => {
    const pendingInputForUser = vi.fn(() => REALTIME_TEST_SESSION_DETAIL);
    const integration = realtimeTestSessionCommands({ pendingInputForUser });
    for (const [operation, kind] of [
      [SESSION_REALTIME_OPERATIONS.followUp, "follow_up"],
      [SESSION_REALTIME_OPERATIONS.steer, "steer"],
    ] as const) {
      await executeSessionRealtimeCommand(
        integration,
        USER,
        userRealtimeCommand(operation, {
          clientRequestId: `${kind}-request`,
          kind,
          prompt: "Continue safely",
          sessionId: "session-1",
        }),
        REALTIME_TEST_SESSION_DETAIL.workspaceId,
      );
    }
    expect(pendingInputForUser).toHaveBeenNthCalledWith(
      1,
      USER,
      {
        attachments: [],
        clientRequestId: "follow_up-request",
        images: [],
        kind: "follow_up",
        prompt: "Continue safely",
        sessionId: "session-1",
      },
      REALTIME_TEST_SESSION_DETAIL.workspaceId,
    );
    expect(pendingInputForUser).toHaveBeenNthCalledWith(
      2,
      USER,
      {
        attachments: [],
        clientRequestId: "steer-request",
        images: [],
        kind: "steer",
        prompt: "Continue safely",
        sessionId: "session-1",
      },
      REALTIME_TEST_SESSION_DETAIL.workspaceId,
    );
  });

  test("dispatches cancellation over authenticated realtime", async () => {
    const cancelPendingInputForUser = vi.fn(() => ({
      detail: REALTIME_TEST_SESSION_DETAIL,
      input: realtimeTestPendingInput("Continue safely"),
    }));
    const integration = realtimeTestSessionCommands({
      cancelPendingInputForUser,
    });

    await executeSessionRealtimeCommand(
      integration,
      USER,
      userRealtimeCommand(SESSION_REALTIME_OPERATIONS.cancelPendingInput, {
        inputId: "pending-1",
        sessionId: "session-1",
      }),
      REALTIME_TEST_SESSION_DETAIL.workspaceId,
    );

    expect(cancelPendingInputForUser).toHaveBeenCalledWith(
      USER,
      "session-1",
      "pending-1",
      REALTIME_TEST_SESSION_DETAIL.workspaceId,
    );
  });

  test("launches only available inactive queued sessions", async () => {
    const credential = createTestProviderCredential("credential", "api_key", {
      accountId: null,
      label: "Test credential",
      credentialFingerprint: "test-credential-fingerprint",
      secret: "test-token",
    });
    const callbacks = { launch: vi.fn(() => true), notify: vi.fn() };

    await launchQueuedSessions(
      {
        draining: () => false,
        launch: callbacks.launch,
        notify: callbacks.notify,
        readCredential: (_userId, _detail, action) => {
          action(credential);
        },
        runnerIsAvailable: (_userId, runnerId) => runnerId === "ready-runner",
        runtimes: { active: (sessionId) => sessionId === "active" },
        store: {
          queuedSessions: () => [
            {
              ...REALTIME_TEST_SESSION_DETAIL,
              id: "ready",
              runnerId: "ready-runner",
              status: "queued",
            },
            {
              ...REALTIME_TEST_SESSION_DETAIL,
              id: "offline",
              runnerId: "offline-runner",
              status: "queued",
            },
            {
              ...REALTIME_TEST_SESSION_DETAIL,
              id: "active",
              runnerId: "ready-runner",
              status: "queued",
            },
          ],
        },
      },
      USER.id,
    );
    expect(callbacks.launch).toHaveBeenCalledOnce();
    expect(callbacks.notify).toHaveBeenCalledWith(USER.id, "ready");
  });
});
