import type { AppDatabase } from "./database.ts";
import type { IdGenerator } from "./ids.ts";

export interface StoreResources {
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
}

export function createStoreResources(
  database: AppDatabase,
  generateId: IdGenerator,
): StoreResources {
  return { database, generateId };
}
