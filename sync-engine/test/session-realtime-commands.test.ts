import { describe, expect, test, vi } from "vitest";
import {
  AGENT_SESSION_TOOL_NAMES,
  type AgentSessionToolName,
} from "../../shared/agent-tools.ts";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import {
  executeSessionRealtimeCommand,
  type SessionRealtimeCommands,
} from "../../sync-engine/session-realtime-commands.ts";
import { userRealtimeCommand } from "./realtime-command-fixtures.ts";
import {
  REALTIME_TEST_SESSION_DETAIL,
  realtimeTestHistoryPage,
  realtimeTestSessionCommands,
} from "./realtime-session-fixture.ts";

const TEST_USER: AuthenticatedUser = {
  email: "mush@example.com",
  id: "user-1",
  name: "Mush",
};
const TEST_WORKSPACE_ID = REALTIME_TEST_SESSION_DETAIL.workspaceId;

function resolvedSessionDetail() {
  return Promise.resolve(REALTIME_TEST_SESSION_DETAIL);
}

function execute(
  integration: SessionRealtimeCommands,
  operation: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return executeSessionRealtimeCommand(
    integration,
    TEST_USER,
    userRealtimeCommand(operation, payload),
    TEST_WORKSPACE_ID,
  );
}

function createPayload(): Readonly<{
  credentialId: string;
  executionEnvironment: "bare_metal";
  model: string;
  prompt: string;
  provider: "openai";
  reasoningEffort: "high";
  runnerId: string;
  tools: readonly AgentSessionToolName[];
  workingDirectory: string;
}> {
  return {
    credentialId: "credential-1",
    executionEnvironment: "bare_metal",
    model: "model-1",
    prompt: "Inspect the workspace",
    provider: "openai",
    reasoningEffort: "high",
    runnerId: "runner-1",
    tools: AGENT_SESSION_TOOL_NAMES,
    workingDirectory: "/work/project",
  };
}

describe("session realtime command dispatch", () => {
  test("routes question answers through the authenticated workspace", async () => {
    const answerQuestionsForUser = vi.fn(() =>
      Promise.resolve({ status: "answered" }),
    );
    const payload = {
      answers: [{ questionId: "direction", value: "proceed" }],
      requestId: "request-1",
      sessionId: "session-1",
    } as const;

    await expect(
      execute(
        realtimeTestSessionCommands({ answerQuestionsForUser }),
        SESSION_REALTIME_OPERATIONS.answerQuestions,
        payload,
      ),
    ).resolves.toEqual({ status: "answered" });
    expect(answerQuestionsForUser).toHaveBeenCalledWith(TEST_USER, {
      ...payload,
      workspaceId: TEST_WORKSPACE_ID,
    });

    await expect(
      execute(
        realtimeTestSessionCommands({ answerQuestionsForUser }),
        SESSION_REALTIME_OPERATIONS.answerQuestions,
        { ...payload, workspaceId: "workspace-forged" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(answerQuestionsForUser).toHaveBeenCalledTimes(1);
  });

  test("routes bounded history through owner and workspace authority", async () => {
    const page = realtimeTestHistoryPage({
      currentSegment: 1,
      sessionId: "session-1",
    });
    const historyForUser = vi.fn(() => page);

    await expect(
      execute(
        realtimeTestSessionCommands({ historyForUser }),
        SESSION_REALTIME_OPERATIONS.history,
        { cursor: null, sessionId: "session-1" },
      ),
    ).resolves.toEqual(page);
    expect(historyForUser).toHaveBeenCalledWith(
      TEST_USER,
      "session-1",
      null,
      TEST_WORKSPACE_ID,
    );
  });

  test("routes reads and subscriptions through the authenticated owner", async () => {
    const detailForUser = vi.fn(() => REALTIME_TEST_SESSION_DETAIL);
    const summariesForUser = vi.fn(() => [REALTIME_TEST_SESSION_DETAIL]);
    const integration = realtimeTestSessionCommands({
      detailForUser,
      summariesForUser,
    });

    await expect(
      execute(integration, SESSION_REALTIME_OPERATIONS.subscribe, {}),
    ).resolves.toEqual({ sessions: [REALTIME_TEST_SESSION_DETAIL] });
    await expect(
      execute(integration, SESSION_REALTIME_OPERATIONS.read, {
        sessionId: "session-1",
      }),
    ).resolves.toEqual(REALTIME_TEST_SESSION_DETAIL);

    expect(summariesForUser).toHaveBeenCalledWith(
      TEST_USER.id,
      TEST_WORKSPACE_ID,
    );
    expect(detailForUser).toHaveBeenCalledWith(
      TEST_USER.id,
      "session-1",
      TEST_WORKSPACE_ID,
    );
  });

  test("strictly parses model, create, and image-bearing send payloads", async () => {
    const image = {
      data: "aGVsbG8=",
      mediaType: "image/png",
      name: "screen.png",
    };
    const createForUser = vi.fn(() =>
      Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    );
    const messageForUser = vi.fn(() =>
      Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    );
    const modelsForUser = vi.fn(() =>
      Promise.resolve({ defaultModel: null, models: [] }),
    );
    const integration = realtimeTestSessionCommands({
      createForUser,
      messageForUser,
      modelsForUser,
    });

    await execute(integration, SESSION_REALTIME_OPERATIONS.models, {
      credentialId: "credential-1",
      provider: "openai",
    });
    await execute(integration, SESSION_REALTIME_OPERATIONS.create, {
      ...createPayload(),
      autoCompact: false,
      images: [image],
    });
    await execute(integration, SESSION_REALTIME_OPERATIONS.send, {
      images: [image],
      prompt: "Review it",
      sessionId: "session-1",
    });

    expect(modelsForUser).toHaveBeenCalledWith({
      credentialId: "credential-1",
      provider: "openai",
      user: TEST_USER,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(createForUser).toHaveBeenCalledWith(
      TEST_USER,
      expect.objectContaining({
        autoCompact: false,
        images: [image],
        prompt: "Inspect the workspace",
      }),
      TEST_WORKSPACE_ID,
    );
    expect(messageForUser).toHaveBeenCalledWith(
      TEST_USER,
      "session-1",
      {
        images: [image],
        prompt: "Review it",
      },
      TEST_WORKSPACE_ID,
    );
  });

  test("dispatches a user spawn with its validated tool subset", async () => {
    const spawnForUser = vi.fn(resolvedSessionDetail);
    const payload = {
      ...createPayload(),
      parentGeneration: 4,
      parentSessionId: "parent-session",
      tools: ["read", "brave_search"],
    } as const;

    await expect(
      execute(
        realtimeTestSessionCommands({ spawnForUser }),
        SESSION_REALTIME_OPERATIONS.spawn,
        payload,
      ),
    ).resolves.toEqual(REALTIME_TEST_SESSION_DETAIL);
    expect(spawnForUser).toHaveBeenCalledWith(
      TEST_USER,
      expect.objectContaining({
        parentGeneration: 4,
        parentSessionId: "parent-session",
        tools: ["read", "brave_search"],
      }),
      TEST_WORKSPACE_ID,
    );
  });

  test("dispatches a session fork in the authenticated workspace", async () => {
    const integration = realtimeTestSessionCommands();
    const forkForUser = vi.spyOn(integration, "forkForUser");
    const payload = {
      credentialId: "credential-2",
      forkPointMessageId: "message-1",
      model: "openai/gpt-5",
      provider: "openrouter" as const,
      reasoningEffort: "high" as const,
      sourceSessionId: "session-1",
      workspaceId: TEST_WORKSPACE_ID,
    };

    await expect(
      execute(integration, SESSION_REALTIME_OPERATIONS.fork, payload),
    ).resolves.toEqual(REALTIME_TEST_SESSION_DETAIL);
    expect(forkForUser).toHaveBeenCalledWith(
      TEST_USER,
      payload,
      TEST_WORKSPACE_ID,
    );

    await expect(
      execute(integration, SESSION_REALTIME_OPERATIONS.fork, {
        ...payload,
        workspaceId: "other-workspace",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(forkForUser).toHaveBeenCalledTimes(1);
  });

  test("dispatches a confirmed provider update in the authenticated workspace", async () => {
    const updateProviderForUser = vi.fn(resolvedSessionDetail);
    const payload = {
      confirmedCacheDrop: true,
      credentialId: "credential-2",
      expectedGeneration: 0,
      model: "model-2",
      openRouterProviderTag: null,
      provider: "openai" as const,
      sessionId: "session-1",
      workspaceId: TEST_WORKSPACE_ID,
    };

    await execute(
      realtimeTestSessionCommands({ updateProviderForUser }),
      SESSION_REALTIME_OPERATIONS.updateProvider,
      payload,
    );

    expect(updateProviderForUser).toHaveBeenCalledWith(TEST_USER, payload);
  });

  test("dispatches all authenticated session mutations", async () => {
    const compactAndContinueForUser = vi.fn(() =>
      Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    );
    const compactForUser = vi.fn(() =>
      Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    );
    const continueForUser = vi.fn(() =>
      Promise.resolve(REALTIME_TEST_SESSION_DETAIL),
    );
    const reassignForUser = vi.fn(() => REALTIME_TEST_SESSION_DETAIL);
    const setAutoCompactionForUser = vi.fn(() => REALTIME_TEST_SESSION_DETAIL);
    const stopForUser = vi.fn(() => REALTIME_TEST_SESSION_DETAIL);
    const integration = realtimeTestSessionCommands({
      compactAndContinueForUser,
      compactForUser,
      continueForUser,
      reassignForUser,
      setAutoCompactionForUser,
      stopForUser,
    });

    await execute(integration, SESSION_REALTIME_OPERATIONS.compact, {
      sessionId: "session-1",
    });
    await execute(integration, SESSION_REALTIME_OPERATIONS.compactAndContinue, {
      sessionId: "session-1",
    });
    await execute(integration, SESSION_REALTIME_OPERATIONS.continue, {
      sessionId: "session-1",
    });
    await execute(integration, SESSION_REALTIME_OPERATIONS.stop, {
      cascade: false,
      sessionId: "session-1",
    });
    await execute(integration, SESSION_REALTIME_OPERATIONS.reassign, {
      runnerId: "runner-2",
      sessionId: "session-1",
      workingDirectory: "/replacement/project",
    });
    await execute(integration, SESSION_REALTIME_OPERATIONS.setAutoCompaction, {
      autoCompact: false,
      sessionId: "session-1",
    });

    expect(compactForUser).toHaveBeenCalledWith(
      TEST_USER,
      "session-1",
      TEST_WORKSPACE_ID,
    );
    expect(compactAndContinueForUser).toHaveBeenCalledWith(
      TEST_USER,
      "session-1",
      TEST_WORKSPACE_ID,
    );
    expect(continueForUser).toHaveBeenCalledWith(
      TEST_USER,
      "session-1",
      TEST_WORKSPACE_ID,
    );
    expect(stopForUser).toHaveBeenCalledWith(
      TEST_USER,
      "session-1",
      false,
      TEST_WORKSPACE_ID,
    );
    expect(reassignForUser).toHaveBeenCalledWith(
      TEST_USER,
      "session-1",
      "runner-2",
      "/replacement/project",
      TEST_WORKSPACE_ID,
    );
    expect(setAutoCompactionForUser).toHaveBeenCalledWith(
      TEST_USER,
      "session-1",
      false,
      TEST_WORKSPACE_ID,
    );
  });

  test("rejects malformed, unowned, and unsupported operations", async () => {
    const integration = realtimeTestSessionCommands({
      detailForUser: () => undefined,
    });

    await expect(
      execute(integration, SESSION_REALTIME_OPERATIONS.read, {
        sessionId: "other-session",
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    for (const [operation, payload] of [
      [SESSION_REALTIME_OPERATIONS.read, {}],
      [SESSION_REALTIME_OPERATIONS.compactAndContinue, {}],
      [SESSION_REALTIME_OPERATIONS.models, { provider: "openai" }],
      [SESSION_REALTIME_OPERATIONS.create, { ...createPayload(), prompt: 1 }],
      [
        SESSION_REALTIME_OPERATIONS.create,
        { ...createPayload(), autoCompact: "false" },
      ],
      [SESSION_REALTIME_OPERATIONS.send, { prompt: "Hi", sessionId: [] }],
      [
        SESSION_REALTIME_OPERATIONS.reassign,
        { runnerId: "runner-2", sessionId: "session-1" },
      ],
      [
        SESSION_REALTIME_OPERATIONS.stop,
        { cascade: "false", sessionId: "session-1" },
      ],
      [
        SESSION_REALTIME_OPERATIONS.setAutoCompaction,
        { autoCompact: "false", sessionId: "session-1" },
      ],
    ] as const) {
      await expect(
        execute(integration, operation, payload),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }

    await expect(
      execute(integration, "sessions.answer_question", {
        answer: "Yes",
        questionId: "question-1",
      }),
    ).rejects.toMatchObject({ code: "unsupported_operation" });
  });
});
