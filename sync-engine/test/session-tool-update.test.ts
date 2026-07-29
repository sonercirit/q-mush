import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { SessionStore } from "../session-store.ts";
import {
  applySessionToolUpdate,
  previewSessionToolUpdate,
  SessionToolUpdateError,
} from "../session-tool-update.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { addSessionTestRunner } from "./session-store-runner-helpers.ts";

function setup() {
  const database = createAuthenticatedTestDatabase();
  addSessionTestRunner(database, "tool-update-machine", "runner-1");
  addTestProviderCredential(database, "credential-1");
  const store = new SessionStore(database);
  const created = store.create(
    {
      autoCompact: true,
      credentialId: "credential-1",
      executionEnvironment: "bare_metal",
      images: [],
      maxContextTokens: null,
      model: "gpt-5-codex",
      openRouterProviderTag: null,
      prompt: "test",
      provider: "openai",
      providerPricing: null,
      reasoningEffort: null,
      runnerId: "runner-1",
      tools: ["read", "bash"],
      userId: TEST_USER_ID,
      workingDirectory: "/tmp",
      workspaceId: TEST_WORKSPACE_ID,
    },
    1,
  );
  if (created.status !== "created") {
    throw new Error("fixture failed");
  }
  const cancelSessionGeneration = vi.fn(() => []);
  const abortForGeneration = vi.fn(() => true);
  const dependencies = {
    broker: { cancelSessionGeneration },
    now: () => 2,
    readCredentialSource: () => Promise.resolve("oauth" as const),
    runtimes: { abortForGeneration },
    store: {
      database,
      read: (userId: string, sessionId: string, workspaceId: string) =>
        store.get(userId, sessionId, workspaceId),
    },
  };
  return {
    abortForGeneration,
    cancelSessionGeneration,
    created,
    database,
    dependencies,
    store,
  };
}

function updateRequest(
  setupValue: ReturnType<typeof setup>,
  tools: readonly ("bash" | "read")[],
  generation = setupValue.created.detail.generation,
) {
  return {
    confirmedCacheDrop: false,
    expectedGeneration: generation,
    sessionId: setupValue.created.detail.id,
    tools,
    workspaceId: TEST_WORKSPACE_ID,
  };
}

function expectOriginalTools(setupValue: ReturnType<typeof setup>): void {
  expect(
    setupValue.store.get(TEST_USER_ID, setupValue.created.detail.id)?.tools,
  ).toEqual(["read", "bash"]);
}

function expectRuntimeFenced(
  setupValue: ReturnType<typeof setup>,
  sessionId: string,
  generation: number,
): void {
  expect(setupValue.abortForGeneration).toHaveBeenCalledWith(
    sessionId,
    generation,
  );
  expect(setupValue.cancelSessionGeneration).toHaveBeenCalledWith(
    sessionId,
    generation,
  );
}

describe("session tool update", () => {
  test("commits tools and generation atomically then fences the old runtime", async () => {
    const setupValue = setup();

    const updated = await applySessionToolUpdate(
      setupValue.dependencies,
      TEST_USER_ID,
      updateRequest(setupValue, ["read"]),
    );
    expect(updated.tools).toEqual(["read"]);
    expect(updated.generation).toBe(setupValue.created.detail.generation + 1);
    expect(updated.status).toBe("idle");
    expectRuntimeFenced(
      setupValue,
      updated.id,
      setupValue.created.detail.generation,
    );
    expect(updated.turns).toHaveLength(1);
    expect(updated.turns?.[0]?.endedAt).not.toBeNull();
    expect(
      setupValue.database
        .select({
          generation: agentSessions.executionGeneration,
          tools: agentSessions.tools,
        })
        .from(agentSessions)
        .where(eq(agentSessions.id, updated.id))
        .get(),
    ).toMatchObject({ generation: updated.generation, tools: '["read"]' });
    expect(setupValue.store.queue(TEST_USER_ID, updated.id, 3).status).toBe(
      "queued",
    );
  });

  test("rejects stale generation without mutation and survives rehydration", async () => {
    const setupValue = setup();
    await expect(
      applySessionToolUpdate(
        setupValue.dependencies,
        TEST_USER_ID,
        updateRequest(setupValue, [], setupValue.created.detail.generation + 1),
      ),
    ).rejects.toMatchObject({ code: "stale_generation" });
    expect(
      new SessionStore(setupValue.database).get(
        TEST_USER_ID,
        setupValue.created.detail.id,
        TEST_WORKSPACE_ID,
      )?.tools,
    ).toEqual(["read", "bash"]);
  });

  test("requires warning confirmation before an unassured provider mutation", async () => {
    const setupValue = setup();
    const dependencies = {
      ...setupValue.dependencies,
      readCredentialSource: () => Promise.resolve("api_key" as const),
    };
    const preview = await previewSessionToolUpdate(dependencies, TEST_USER_ID, {
      sessionId: setupValue.created.detail.id,
      tools: [],
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(preview.cacheDisposition).toBe("warning_required");
    await expect(
      applySessionToolUpdate(
        dependencies,
        TEST_USER_ID,
        updateRequest(setupValue, []),
      ),
    ).rejects.toBeInstanceOf(SessionToolUpdateError);
    expectOriginalTools(setupValue);
  });
});
