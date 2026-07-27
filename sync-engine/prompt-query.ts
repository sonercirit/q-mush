import { and, eq, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { prompts } from "../shared/database/schema.ts";
import { selectedString } from "./database-count.ts";

const PROMPT_ID_SELECTION = { column: prompts.id, table: prompts } as const;

export const PROMPT_STATE_SELECTION = {
  isDeleted: prompts.isDeleted,
  revision: prompts.revision,
};

export function promptStateCondition(userId: string, promptId: string) {
  return and(eq(prompts.userId, userId), eq(prompts.id, promptId));
}

export function storedPromptId(
  parameters: readonly [
    database: Pick<AppDatabase, "select">,
    condition: SQL | undefined,
  ],
): string | undefined {
  const [database, condition] = parameters;
  return selectedString(database, PROMPT_ID_SELECTION, condition);
}
