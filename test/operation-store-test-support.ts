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
