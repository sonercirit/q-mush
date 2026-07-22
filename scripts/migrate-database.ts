import { createDatabase } from "../shared/database.ts";
import { readDatabasePath } from "../shared/database/config.ts";

const databasePath = readDatabasePath(Bun.env);
const database = createDatabase(databasePath);
database.$client.close();

console.log(`Database migrations applied to ${databasePath}`);
