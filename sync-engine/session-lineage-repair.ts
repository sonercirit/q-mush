import { and, eq, isNull, or } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentMessages,
  agentSessions,
  agentSessionTurns,
} from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import { storedSessionCondition } from "./session-store-persistence.ts";

export interface SpawnLineageRepairResult {
  readonly ambiguous: number;
  readonly repaired: number;
  readonly skipped: number;
}

interface SpawnProvenance {
  readonly childId: string;
  readonly generation: number;
  readonly parentId: string;
}

interface RepairableSession {
  readonly generation: number | null;
  readonly id: string;
  readonly parentId: string | null;
  readonly userId: string;
  readonly workspaceId: string;
}

function parsedSessionId(output: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    return isRecord(parsed) && typeof parsed["sessionId"] === "string"
      ? parsed["sessionId"]
      : undefined;
  } catch {
    return undefined;
  }
}

function directSpawnIds(toolName: string, content: string): readonly string[] {
  if (toolName === "spawn_session") {
    const childId = parsedSessionId(content);
    return childId === undefined ? [] : [childId];
  }
  if (toolName !== "parallel") return [];
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): readonly string[] => {
      if (
        !isRecord(value) ||
        value["recipient_name"] !== "spawn_session" ||
        typeof value["output"] !== "string"
      ) {
        return [];
      }
      const childId = parsedSessionId(value["output"]);
      return childId === undefined ? [] : [childId];
    });
  } catch {
    return [];
  }
}

function nativeSpawnProvenance(
  database: AppDatabase,
): readonly SpawnProvenance[] {
  const rows = database
    .select({
      content: agentMessages.content,
      generation: agentSessionTurns.executionGeneration,
      parentId: agentMessages.sessionId,
      toolName: agentMessages.toolName,
    })
    .from(agentMessages)
    .innerJoin(
      agentSessionTurns,
      and(
        eq(agentSessionTurns.id, agentMessages.turnId),
        eq(agentSessionTurns.sessionId, agentMessages.sessionId),
        eq(agentSessionTurns.userId, agentMessages.userId),
        eq(agentSessionTurns.isDeleted, false),
      ),
    )
    .where(
      and(
        eq(agentMessages.role, "tool"),
        or(
          eq(agentMessages.toolName, "spawn_session"),
          eq(agentMessages.toolName, "parallel"),
        ),
      ),
    )
    .all();
  return rows.flatMap(({ content, generation, parentId, toolName }) =>
    toolName === null
      ? []
      : directSpawnIds(toolName, content).map((childId) => ({
          childId,
          generation,
          parentId,
        })),
  );
}

function distinctProvenance(
  candidates: readonly SpawnProvenance[],
): readonly SpawnProvenance[] {
  return [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.parentId}:${String(candidate.generation)}`,
        candidate,
      ]),
    ).values(),
  ];
}

function wouldCreateCycle(
  childId: string,
  parentId: string,
  parentIds: ReadonlyMap<string, string | null>,
): boolean {
  const visited = new Set<string>();
  let current: string | null | undefined = parentId;
  while (current !== null && current !== undefined && !visited.has(current)) {
    if (current === childId) return true;
    visited.add(current);
    current = parentIds.get(current);
  }
  return false;
}

function candidateMatches(
  candidate: SpawnProvenance,
  child: RepairableSession,
  activeById: ReadonlyMap<string, RepairableSession>,
  parentIds: ReadonlyMap<string, string | null>,
): boolean {
  const parent = activeById.get(candidate.parentId);
  return (
    parent !== undefined &&
    parent.id !== child.id &&
    parent.userId === child.userId &&
    parent.workspaceId === child.workspaceId &&
    (child.parentId === null || child.parentId === parent.id) &&
    (child.generation === null || child.generation === candidate.generation) &&
    !wouldCreateCycle(child.id, parent.id, parentIds)
  );
}

function repairCondition(child: RepairableSession) {
  return and(
    storedSessionCondition({
      id: child.id,
      userId: child.userId,
      workspaceId: child.workspaceId,
    }),
    child.parentId === null
      ? isNull(agentSessions.parentSessionId)
      : eq(agentSessions.parentSessionId, child.parentId),
    child.generation === null
      ? isNull(agentSessions.parentExecutionGeneration)
      : eq(agentSessions.parentExecutionGeneration, child.generation),
  );
}

export function repairSpawnedSessionLineage(
  database: AppDatabase,
  now = Date.now(),
): SpawnLineageRepairResult {
  const provenance = nativeSpawnProvenance(database);
  const childIds = new Set(provenance.map(({ childId }) => childId));
  if (childIds.size === 0) {
    return { ambiguous: 0, repaired: 0, skipped: 0 };
  }
  return database.transaction((transaction) => {
    const active = transaction.query.agentSessions
      .findMany({
        columns: {
          id: true,
          parentExecutionGeneration: true,
          parentSessionId: true,
          userId: true,
          workspaceId: true,
        },
        where: eq(agentSessions.isDeleted, false),
      })
      .sync()
      .map((session): RepairableSession => ({
        generation: session.parentExecutionGeneration,
        id: session.id,
        parentId: session.parentSessionId,
        userId: session.userId,
        workspaceId: session.workspaceId,
      }));
    const sessions = active.filter(
      (session) =>
        childIds.has(session.id) &&
        (session.parentId === null || session.generation === null),
    );
    const activeById = new Map(active.map((session) => [session.id, session]));
    const parentIds = new Map(
      active.map(({ id, parentId }) => [id, parentId] as const),
    );
    const evidenceByChild = new Map<string, SpawnProvenance[]>();
    for (const evidence of provenance) {
      const candidates = evidenceByChild.get(evidence.childId) ?? [];
      candidates.push(evidence);
      evidenceByChild.set(evidence.childId, candidates);
    }

    let ambiguous = 0;
    let repaired = 0;
    let skipped = 0;
    const repairs: {
      readonly candidate: SpawnProvenance;
      readonly child: RepairableSession;
    }[] = [];
    for (const child of sessions) {
      const candidates = distinctProvenance(
        (evidenceByChild.get(child.id) ?? []).filter((candidate) =>
          candidateMatches(candidate, child, activeById, parentIds),
        ),
      );
      const candidate = candidates[0];
      if (candidates.length !== 1 || candidate === undefined) {
        if (candidates.length > 1) ambiguous += 1;
        else skipped += 1;
        continue;
      }
      repairs.push({ candidate, child });
    }
    const proposedParentIds = new Map(parentIds);
    for (const { candidate, child } of repairs) {
      proposedParentIds.set(child.id, candidate.parentId);
    }
    for (const { candidate, child } of repairs) {
      if (wouldCreateCycle(child.id, candidate.parentId, proposedParentIds)) {
        skipped += 1;
        continue;
      }
      const updated = transaction
        .update(agentSessions)
        .set({
          parentExecutionGeneration: candidate.generation,
          parentSessionId: candidate.parentId,
          ...updatedAuditFields(SYSTEM_ID, now),
        })
        .where(repairCondition(child))
        .returning({ id: agentSessions.id })
        .all();
      if (updated.length === 1) repaired += 1;
      else skipped += 1;
    }
    return { ambiguous, repaired, skipped };
  });
}
