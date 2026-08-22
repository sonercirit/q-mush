import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionAgentActionDependencies } from "./session-agent-action-helpers.ts";
import { spawnedSessionReport } from "./session-spawn-report.ts";

export interface SpawnedSessionCompletion {
  readonly disposition: "deferred" | "delivered" | "promoted" | "terminal";
  readonly parentId: string;
}

export function reportCanWakeParent(
  report: SpawnedSessionCompletion | undefined,
): report is SpawnedSessionCompletion {
  return (
    report?.disposition === "delivered" || report?.disposition === "deferred"
  );
}

export function reportSpawnedSessionCompletion(
  dependencies: SessionAgentActionDependencies,
  detail: AgentSessionDetail,
  userId: string,
): SpawnedSessionCompletion | undefined {
  const link = dependencies.store.spawnedSessionLink(userId, detail.id);
  if (link === undefined) {
    return undefined;
  }
  const report = spawnedSessionReport(detail, link.parentId);
  if (report === undefined) {
    return undefined;
  }
  const delivered = dependencies.store.spawnedSessionCallbackDisposition(
    userId,
    detail.id,
    detail.generation,
    report.parentId,
    link.parentGeneration,
    report.content,
    dependencies.now(),
  );
  return delivered === undefined
    ? undefined
    : { disposition: delivered, parentId: report.parentId };
}

export function stopSpawnedSessionChildren(
  dependencies: SessionAgentActionDependencies,
  parent: AgentSessionDetail,
  userId: string,
  stopChild: (child: AgentSessionDetail) => void,
  reportedParent: (report: SpawnedSessionCompletion) => void,
): void {
  for (const childId of dependencies.store.activeSpawnedSessionChildren(
    userId,
    parent.id,
  )) {
    const child = dependencies.store.get(userId, childId);
    if (child === undefined) {
      continue;
    }
    dependencies.store.stop(userId, childId, dependencies.now());
    stopChild(child);
    dependencies.notify(userId, childId);
    const reported = reportSpawnedSessionCompletion(
      dependencies,
      dependencies.store.get(userId, childId) ?? child,
      userId,
    );
    if (reported !== undefined) {
      dependencies.notify(userId, reported.parentId);
      reportedParent(reported);
    }
  }
}
