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
  compareClocks,
  createOperation,
  frontierCovers,
  materializeApplied,
  operationFingerprint,
  type Operation,
} from "../shared/operation-core";
import { classifyOperationPartition } from "../shared/operation-partitions";
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

const valueReducer = (
  projection: Readonly<Record<string, string>>,
  candidate: Operation,
): Readonly<Record<string, string>> => ({
  ...projection,
  [candidate.operationId]:
    typeof candidate.payload === "object" && candidate.payload !== null
      ? String(Reflect.get(candidate.payload, "value"))
      : "invalid",
});

describe("operation frontier and clocks", () => {
  test("revalidates a created operation's mutated partition", () => {
    const base = operation("writer", 1n, {}, "one");
    const created = createOperation({
      operationId: base.operationId,
      schemaVersion: base.schemaVersion,
      writerId: base.writerId,
      sequence: base.sequence,
      clock: base.clock,
      parents: base.parents,
      entity: { type: "users", id: "user-1", accountId: "account-1" },
      kind: base.kind,
      payload: base.payload,
    });
    Reflect.set(created, "partition", "session");
    const applyCreated = () =>
      applyOperation(initialApplyState(), created, reducer);
    expect(applyCreated).toThrow(/partition mismatch/);
  });

  test("snapshots a created operation's mutated payload at apply admission", () => {
    const created = createOperation({
      ...operation("writer", 1n, {}, "before"),
      payload: { value: "before" },
    });
    created.payload.value = "admitted";
    const applyState = () =>
      applyOperation(initialApplyState(), created, valueReducer);
    const state = applyState();
    const admitted = state.replayHead?.operation;
    created.payload.value = "after-apply";
    const fingerprint = operationFingerprint(admitted);
    expect(state.projection).toEqual({ "writer-1": "admitted" });
    expect(admitted?.payload).toEqual({ value: "admitted" });
    expect(operationFingerprint(admitted)).toBe(fingerprint);
    expect(materializeApplied(state.applied)["id:writer-1"]).toBe(fingerprint);
  });

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
    for (const [entity, partition] of expectedEntities) {
      expect(classifyOperationPartition(entity)).toBe(partition);
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

  test("advances prototype-named writer keys as own frontier properties", () => {
    const item = operation("__proto__", 1n, {}, "one");
    const state = applyOperation(initialApplyState(), item, reducer);
    expect(Object.hasOwn(state.frontier, "__proto__")).toBe(true);
    expect(state.frontier["__proto__"]).toBe(1n);
    const required = Object.fromEntries([["__proto__", 1n]]);
    expect(frontierCovers(state.frontier, required)).toBe(true);
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
