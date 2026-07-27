import type { AppDatabase } from "../shared/database.ts";

export function sqliteChangeCount(
  database: Pick<AppDatabase, "$client">,
  errorMessage: string,
): number {
  const changes = database.$client
    .query<{ changes: number }, []>("SELECT changes() AS changes")
    .get()?.changes;
  if (changes === undefined) {
    throw new Error(errorMessage);
  }
  return changes;
}
