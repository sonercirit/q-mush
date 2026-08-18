import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import {
  agentMessages,
  agentSessions,
  agentSessionTurns,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionStore } from "../session-store.ts";
import { insertWorkspace } from "../workspace-write.ts";
import {
  addTestUser,
  TEST_FOREIGN_USER_ID,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  createStore,
  createTestSession,
} from "./session-store-test-fixtures.ts";

type StoreSetup = ReturnType<typeof createStore>;

interface LineageRepairSetup extends StoreSetup {
  readonly child: AgentSessionDetail;
  readonly parent: AgentSessionDetail;
  readonly turnId: string;
}

function toolResult(
  setup: LineageRepairSetup,
  options: {
    readonly content: string;
    readonly id: string;
    readonly parentId?: string;
    readonly toolName: string;
    readonly turnId?: string;
  },
): void {
  setup.database
    .insert(agentMessages)
    .values({
      ...createdAuditFields(SYSTEM_ID, TEST_NOW + 2),
      content: options.content,
      id: options.id,
      role: "tool",
      sessionId: options.parentId ?? setup.parent.id,
      toolCallId: `call-${options.id}`,
      toolName: options.toolName,
      turnId: options.turnId ?? setup.turnId,
      userId: TEST_USER_ID,
    })
    .run();
}

function sessionTurnId(setup: StoreSetup, sessionId: string): string {
  const turn = setup.database.query.agentSessionTurns
    .findFirst({
      columns: { id: true },
      where: eq(agentSessionTurns.sessionId, sessionId),
    })
    .sync();
  if (turn === undefined) throw new Error("Session turn unavailable");
  return turn.id;
}

function orphanSetup(): LineageRepairSetup {
  const setup = createStore();
  const parent = createTestSession(setup.store);
  const childNow = TEST_NOW + 1;
  const child = createTestSession(setup.store, childNow);
  const partial = { ...setup, child, parent };
  return { ...partial, turnId: sessionTurnId(partial, parent.id) };
}

function updateChild(
  setup: LineageRepairSetup,
  values: Partial<typeof agentSessions.$inferInsert>,
): void {
  const condition = eq(agentSessions.id, setup.child.id);
  setup.database
    .update(agentSessions)
    .set({ ...values })
    .where(condition)
    .run();
}

function clearLineage(setup: LineageRepairSetup): void {
  updateChild(setup, {
    parentCallbackGeneration: null,
    parentExecutionGeneration: null,
    parentSessionId: null,
  });
}

function stableLineage(setup: LineageRepairSetup) {
  return {
    parentExecutionGeneration: setup.parent.generation,
    parentSessionId: setup.parent.id,
  };
}

function expectChild(
  setup: LineageRepairSetup,
  expected: Partial<AgentSessionDetail>,
): void {
  expect(setup.store.get(TEST_USER_ID, setup.child.id)).toMatchObject(expected);
}

function storedSessionLineage(
  setup: LineageRepairSetup,
  sessionId = setup.child.id,
) {
  return setup.database.query.agentSessions
    .findFirst({
      columns: {
        parentExecutionGeneration: true,
        parentSessionId: true,
      },
      where: eq(agentSessions.id, sessionId),
    })
    .sync();
}

function expectUnlinkedSession(
  setup: LineageRepairSetup,
  sessionId = setup.child.id,
): void {
  expect(storedSessionLineage(setup, sessionId)).toEqual({
    parentExecutionGeneration: null,
    parentSessionId: null,
  });
}

function expectUnlinked(setup: LineageRepairSetup): void {
  expectUnlinkedSession(setup);
}

function spawnOutput(childId: string): string {
  return JSON.stringify({ sessionId: childId, status: "spawned" });
}

function directProvenance(
  setup: LineageRepairSetup,
  id: string,
  options: { readonly parentId?: string; readonly turnId?: string } = {},
): void {
  toolResult(setup, {
    content: spawnOutput(setup.child.id),
    id,
    ...options,
    toolName: "spawn_session",
  });
}

function directOrphan(id: string): LineageRepairSetup {
  const setup = orphanSetup();
  clearLineage(setup);
  directProvenance(setup, id);
  return setup;
}

function expectRepairResult(
  setup: LineageRepairSetup,
  expected: ReturnType<SessionStore["repairSpawnedSessionLineage"]>,
  now = TEST_NOW + 3,
): void {
  expect(setup.store.repairSpawnedSessionLineage(now)).toEqual(expected);
}

function expectRepairRejected(setup: LineageRepairSetup, skipped = 1): void {
  expectRepairResult(setup, { ambiguous: 0, repaired: 0, skipped });
  expectUnlinked(setup);
  closeSetup(setup);
}

function expectRepairSucceeded(
  setup: LineageRepairSetup,
  now = TEST_NOW + 3,
): void {
  expectRepairResult(setup, { ambiguous: 0, repaired: 1, skipped: 0 }, now);
  expectChild(setup, stableLineage(setup));
}

function closeSetup(setup: LineageRepairSetup): void {
  setup.database.$client.close();
}

describe("native spawn lineage repair", () => {
  test.each(["direct", "parallel"] as const)(
    "repairs one same-owner workspace %s result without rearming its callback",
    (kind) => {
      const setup = orphanSetup();
      clearLineage(setup);
      toolResult(setup, {
        content:
          kind === "direct"
            ? spawnOutput(setup.child.id)
            : JSON.stringify([
                {
                  output: spawnOutput(setup.child.id),
                  recipient_name: "spawn_session",
                },
              ]),
        id: `repair-${kind}`,
        toolName: kind === "direct" ? "spawn_session" : "parallel",
      });

      expectRepairSucceeded(setup);
      expect(setup.store.pendingSpawnedSessions()).toEqual([]);
      closeSetup(setup);
    },
  );

  test("repairs provenance retained by parent compaction", () => {
    const setup = orphanSetup();
    clearLineage(setup);
    expect(
      setup.store.transitionCurrent(setup.parent.id, "running", TEST_NOW + 1),
    ).toBe(true);
    directProvenance(setup, "repair-compacted");

    setup.store.compactCurrentConversation(
      setup.parent.id,
      "Continue after the historical spawn.",
      { contextTokens: 10, costBasis: null, costUsd: null },
      TEST_NOW + 3,
    );
    expect(
      setup.database.query.agentMessages
        .findFirst({
          columns: { isDeleted: true },
          where: eq(agentMessages.id, "repair-compacted"),
        })
        .sync(),
    ).toEqual({ isDeleted: true });

    expectRepairSucceeded(setup, TEST_NOW + 4);
    closeSetup(setup);
  });

  test("rejects cross-owner native provenance", () => {
    const setup = directOrphan("repair-cross-owner");
    addTestUser(setup.database);
    updateChild(setup, { userId: TEST_FOREIGN_USER_ID });

    expectRepairRejected(setup);
  });

  test("rejects cross-workspace native provenance", () => {
    const setup = directOrphan("repair-cross-workspace");
    const otherWorkspaceId = "018bcfe5-6800-7000-8000-000000000099";
    insertWorkspace(setup.database, {
      id: otherWorkspaceId,
      name: "Other workspace",
      now: TEST_NOW,
      userId: TEST_USER_ID,
    });
    updateChild(setup, { workspaceId: otherWorkspaceId });

    expectRepairRejected(setup);
  });

  test.each(["parent", "child"] as const)(
    "ignores provenance with a soft-deleted %s",
    (deletedSession) => {
      const setup = directOrphan(`repair-deleted-${deletedSession}`);
      setup.database
        .update(agentSessions)
        .set({ isDeleted: true })
        .where(
          eq(
            agentSessions.id,
            deletedSession === "parent" ? setup.parent.id : setup.child.id,
          ),
        )
        .run();

      expectRepairRejected(setup, deletedSession === "parent" ? 1 : 0);
    },
  );

  test("rejects self-link provenance", () => {
    const setup = orphanSetup();
    clearLineage(setup);
    directProvenance(setup, "repair-self-link", {
      parentId: setup.child.id,
      turnId: sessionTurnId(setup, setup.child.id),
    });

    expectRepairRejected(setup);
  });

  test("rejects provenance that would create a cycle", () => {
    const setup = directOrphan("repair-cycle");
    setup.database
      .update(agentSessions)
      .set({
        parentExecutionGeneration: setup.child.generation,
        parentSessionId: setup.child.id,
      })
      .where(eq(agentSessions.id, setup.parent.id))
      .run();

    expectRepairRejected(setup);
  });

  test("rejects mutually inferred orphan links that form a cycle", () => {
    const setup = directOrphan("repair-mutual-child");
    toolResult(setup, {
      content: spawnOutput(setup.parent.id),
      id: "repair-mutual-parent",
      parentId: setup.child.id,
      toolName: "spawn_session",
      turnId: sessionTurnId(setup, setup.child.id),
    });

    expectRepairResult(setup, { ambiguous: 0, repaired: 0, skipped: 2 });
    expectUnlinked(setup);
    expectUnlinkedSession(setup, setup.parent.id);
    closeSetup(setup);
  });

  test.each(["parent", "generation"] as const)(
    "preserves a conflicting partial %s lineage",
    (conflict) => {
      const setup = orphanSetup();
      const otherParent = createTestSession(setup.store, TEST_NOW + 2);
      clearLineage(setup);
      updateChild(
        setup,
        conflict === "parent"
          ? { parentSessionId: otherParent.id }
          : { parentExecutionGeneration: setup.parent.generation + 1 },
      );
      directProvenance(setup, `repair-conflicting-${conflict}`);

      expectRepairResult(setup, { ambiguous: 0, repaired: 0, skipped: 1 });
      expect(storedSessionLineage(setup)).toEqual(
        conflict === "parent"
          ? {
              parentExecutionGeneration: null,
              parentSessionId: otherParent.id,
            }
          : {
              parentExecutionGeneration: setup.parent.generation + 1,
              parentSessionId: null,
            },
      );
      closeSetup(setup);
    },
  );

  test("fails a pending reservation on store recreation without losing lineage", () => {
    const setup = orphanSetup();
    updateChild(setup, {
      parentCallbackGeneration: setup.parent.generation,
      parentExecutionGeneration: setup.parent.generation,
      parentSessionId: setup.parent.id,
      spawnPreparationPending: true,
    });
    const recreated = new SessionStore(setup.database);

    expect(recreated.recoverSpawnedSessionReservations(TEST_NOW + 5)).toBe(1);
    expectChild(setup, { ...stableLineage(setup), status: "failed" });
    const pending = recreated.pendingSpawnedSessions();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.userId).toBe(TEST_USER_ID);
    expect(pending[0]?.detail.id).toBe(setup.child.id);
    closeSetup(setup);
  });

  test("skips malformed, generic shell, and ambiguous native provenance", () => {
    const setup = orphanSetup();
    const secondParent = createTestSession(setup.store, TEST_NOW + 2);
    const secondTurn = sessionTurnId(setup, secondParent.id);
    clearLineage(setup);
    toolResult(setup, {
      content: spawnOutput(setup.child.id),
      id: "repair-bash",
      toolName: "bash",
    });
    toolResult(setup, {
      content: "not json",
      id: "repair-malformed",
      toolName: "spawn_session",
    });
    for (const [parent, turnId, id] of [
      [setup.parent, setup.turnId, "repair-first"],
      [secondParent, secondTurn, "repair-second"],
    ] as const) {
      toolResult(setup, {
        content: spawnOutput(setup.child.id),
        id,
        parentId: parent.id,
        toolName: "spawn_session",
        turnId,
      });
    }

    expectRepairResult(
      setup,
      { ambiguous: 1, repaired: 0, skipped: 0 },
      TEST_NOW + 4,
    );
    expectUnlinked(setup);
    closeSetup(setup);
  });
});
