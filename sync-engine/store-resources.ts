import type { AppDatabase } from "../shared/database.ts";
import type { IdGenerator } from "../shared/ids.ts";

export class StoreResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;

  constructor(database: AppDatabase, generateId: IdGenerator) {
    this.database = database;
    this.generateId = generateId;
  }
}
