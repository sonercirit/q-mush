import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  spawnedSessionReport,
  type SessionAgentActionDependencies,
} from "./session-agent-action-helpers.ts";

export interface SpawnedSessionCompletion {
  readonly disposition: "reportable" | "terminal";
  readonly parentId: string;
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
  const report = spawnedSessionReport({
    childId: detail.id,
    dependencies,
    parentId: link.parentId,
    userId,
  });
  if (report === undefined) {
    return undefined;
  }
  const disposition = dependencies.store.spawnedSessionCallbackDisposition(
    userId,
    detail.id,
    detail.generation,
    report.parentId,
    link.parentGeneration,
    report.content,
    dependencies.now(),
  );
  return disposition === false
    ? undefined
    : { disposition, parentId: report.parentId };
}

export function stopSpawnedSessionChildren(
  dependencies: SessionAgentActionDependencies,
  parent: AgentSessionDetail,
  userId: string,
  stopChild: (child: AgentSessionDetail) => void,
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
      dependencies.notify(
        userId,
        reported.disposition === "reportable" ? reported.parentId : childId,
      );
    }
  }
}
