import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
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
}

export function emitReportedParent(
  resources: Pick<SessionStoreWriteResources, "reportParent">,
  userId: string,
  report: ReportedParentEvent | undefined,
): void {
  if (report !== undefined) resources.reportParent?.(userId, report);
}
