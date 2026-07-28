import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { SessionDetailLookup } from "./session-command-types.ts";

export interface SessionStoreWriteResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly read: SessionDetailLookup;
}
