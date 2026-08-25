import { getTableName } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import {
  agentMessages,
  agentPendingInputs,
  agentQuestionRequests,
  agentSessionOperations,
  agentSessions,
  agentSessionTurns,
  attachmentFallbacks,
  prompts,
  providerCredentialWorkspaces,
  providerQuotaResetReceipts,
  providerQuotaSettings,
  runnerWorkspaces,
  toolSettings,
  users,
  workspaces,
} from "../shared/database/schema";
import {
  applyOperation,
  classifyOperationPartition,
  compareClocks,
  createHybridLogicalClock,
  MAX_REMOTE_CLOCK_DRIFT_MS,
  operationEntityPartitions,
} from "../shared/operation-core";
import { testApplyState, testOperation } from "./operation-core-test-support";

const replicatedTables = [
  agentMessages,
  agentPendingInputs,
  agentQuestionRequests,
  agentSessionOperations,
  agentSessions,
  agentSessionTurns,
  attachmentFallbacks,
  prompts,
  providerCredentialWorkspaces,
  providerQuotaResetReceipts,
  providerQuotaSettings,
  runnerWorkspaces,
  toolSettings,
  users,
  workspaces,
];

const operation = testOperation;
const initialApplyState = () =>
  testApplyState<Readonly<Record<string, string>>>({});
const reducer = (projection: Readonly<Record<string, string>>) => projection;

describe("operation frontier and clocks", () => {
  test("classifies the explicit replicated schema allow-list", () => {
    const expectedEntities = [
      ["agent_sessions", "session"],
      ["agent_session_operations", "session"],
      ["agent_session_turns", "session"],
      ["agent_pending_inputs", "session"],
      ["agent_question_requests", "session"],
      ["agent_messages", "session"],
      ["users", "non-session"],
      ["workspaces", "non-session"],
      ["prompts", "non-session"],
      ["provider_quota_settings", "non-session"],
      ["provider_quota_reset_receipts", "non-session"],
      ["provider_credential_workspaces", "non-session"],
      ["attachment_fallbacks", "non-session"],
      ["runner_workspaces", "non-session"],
      ["tool_settings", "non-session"],
    ] as const;
    expect(operationEntityPartitions.session).toHaveLength(6);
    expect(operationEntityPartitions["non-session"]).toHaveLength(9);
    for (const [entity, partition] of expectedEntities) {
      expect(classifyOperationPartition(entity)).toBe(partition);
      expect(operationEntityPartitions[partition]).toContain(entity);
    }
    for (const excluded of ["sessions", "provider_credentials", "runners"])
      expect(() => classifyOperationPartition(excluded)).toThrow(
        /Unknown operation entity/,
      );
    expect(() => classifyOperationPartition("future_entity")).toThrow(
      /Unknown operation entity/,
    );
    const schemaNames = new Set(replicatedTables.map(getTableName));
    for (const name of expectedEntities.map(([entity]) => entity))
      expect(schemaNames.has(name)).toBe(true);
  });

  test("covers every HLC receive winner and rejects far-future clocks", () => {
    expect(MAX_REMOTE_CLOCK_DRIFT_MS).toBe(300_000);
    const receive = (initial: number, now: number) =>
      createHybridLogicalClock("a", initial).receive(
        { physicalMs: 110, logical: 4, writerId: "b" },
        now,
      );
    expect(receive(100, 105).logical).toBe(5);
    expect(receive(110, 105)).toMatchObject({ physicalMs: 110, logical: 5 });
    expect(receive(120, 105)).toMatchObject({ physicalMs: 120, logical: 1 });
    expect(receive(100, 120)).toMatchObject({ physicalMs: 120, logical: 0 });
    const nowWins = createHybridLogicalClock("a", 100);
    expect(() =>
      nowWins.receive(
        {
          physicalMs: 120 + MAX_REMOTE_CLOCK_DRIFT_MS + 1,
          logical: 0,
          writerId: "b",
        },
        120,
      ),
    ).toThrow(/future/);
  });

  test("uses a strict locale-independent clock and canonical key order", () => {
    const left = { physicalMs: 1, logical: 1, writerId: "z" };
    const right = { physicalMs: 1, logical: 1, writerId: "ä" };
    expect(compareClocks(left, right)).toBe(-1);
    expect(compareClocks(right, left)).toBe(1);
    expect(
      compareClocks(
        { physicalMs: 1, logical: 1, writerId: "a" },
        { physicalMs: 1, logical: 2, writerId: "a" },
      ),
    ).toBe(-1);
    const first = operation("a", 1n, {}, "one");
    const applied = applyOperation(initialApplyState(), first, reducer);
    const reordered = {
      ...first,
      payload: { value: "one" },
      entity: { accountId: "account-1", id: "workspace-1", type: "workspaces" },
    };
    expect(applyOperation(applied, reordered, reducer)).toBe(applied);
  });
});
