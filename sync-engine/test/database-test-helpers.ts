import type { AppDatabase } from "../../shared/database.ts";

export function closeTrackedDatabases(databases: AppDatabase[]): void {
  for (const database of databases.splice(0)) {
    database.$client.close();
  }
}
