import { createdAuditFields } from "../shared/audit";
import { createDatabase } from "../shared/database";
import { users } from "../shared/database/schema";
import { SYSTEM_ID } from "../shared/ids";

export const setupOperationDatabase = () => {
  const database = createDatabase(":memory:");
  database
    .insert(users)
    .values({
      id: "owner-1",
      googleSubject: "subject-1",
      email: "owner@example.com",
      name: "Owner",
      ...createdAuditFields(SYSTEM_ID, 1),
    })
    .run();
  let id = 0;
  return {
    database,
    generateId: () => `generated-${String(++id)}`,
  };
};

export const createOperationDatabaseHarness = () => {
  const databases: ReturnType<typeof createDatabase>[] = [];
  return {
    close: () => {
      for (const database of databases.splice(0)) database.$client.close();
    },
    current: () => {
      const database = databases[0];
      if (database === undefined) throw new Error("Missing test database");
      return database;
    },
    setup: () => {
      const resources = setupOperationDatabase();
      databases.push(resources.database);
      return resources;
    },
  };
};
