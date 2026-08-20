import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { SessionDetailLookup } from "./session-command-types.ts";

import type { SpawnedReportDisposition } from "./session-store-spawns.ts";

export interface ReportedParentEvent {
  readonly disposition: SpawnedReportDisposition;
  readonly parentId: string;
}

export interface SessionStoreWriteResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly read: SessionDetailLookup;
  readonly reportParent?: (userId: string, report: ReportedParentEvent) => void;
  readonly toolSettings: (userId: string) => ToolSettings;
}

export function readUpdatedSessionDetail(
  resources: Pick<SessionStoreWriteResources, "read">,
  userId: string,
  sessionId: string,
  workspaceId: string,
  error: string,
): AgentSessionDetail {
  const detail = resources.read(userId, sessionId, workspaceId);
  if (detail === undefined) throw new Error(error);
  return detail;
}

export function emitReportedParent(
  resources: Pick<SessionStoreWriteResources, "reportParent">,
  userId: string,
  report: ReportedParentEvent | undefined,
): void {
  if (report !== undefined) resources.reportParent?.(userId, report);
}
