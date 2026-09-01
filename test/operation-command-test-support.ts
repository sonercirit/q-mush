import type { AppDatabase } from "../shared/database";
import {
  addTestUser,
  createAuthenticatedTestDatabase,
} from "../sync-engine/test/authenticated-integration-test-helpers";

const ids = [
  "018bcfe5-6800-7000-8000-000000000071",
  "018bcfe5-6800-7000-8000-000000000072",
  "018bcfe5-6800-7000-8000-000000000073",
];
export const commandStoreResources = () => {
  const database = createAuthenticatedTestDatabase();
  addTestUser(database);
  let index = 0;
  const generateId = () =>
    ids[index++] ??
    `018bcfe5-6800-7000-8000-${String(index).padStart(12, "0")}`;
  return { database, generateId };
};
export type CommandTestDatabase = AppDatabase;
