import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export interface SessionStoreWriteResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly read: (
    userId: string,
    sessionId: string,
  ) => AgentSessionDetail | undefined;
}
