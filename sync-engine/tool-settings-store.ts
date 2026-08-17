import { and, eq } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { toolSettings } from "../shared/database/schema.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import { createStoreResources } from "../shared/store-resources.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  type ToolSettings,
} from "../shared/tool-limits.ts";
import { sqliteChangeCount } from "./database-changes.ts";

function activeSettingsCondition(userId: string) {
  return and(
    eq(toolSettings.userId, userId),
    eq(toolSettings.isDeleted, false),
  );
}

export class ToolSettingsStore {
  readonly #database: AppDatabase;
  readonly #idAt: IdGenerator;

  constructor(database: AppDatabase, generateId: IdGenerator = createUuidV7) {
    const settingsResources = createStoreResources(database, generateId);
    this.#idAt = settingsResources.generateId;
    this.#database = settingsResources.database;
  }

  read(userId: string): ToolSettings {
    return (
      this.#database
        .select({
          executionLimitMinutes: toolSettings.executionLimitMinutes,
          outputLimitCharacters: toolSettings.outputLimitCharacters,
        })
        .from(toolSettings)
        .where(activeSettingsCondition(userId))
        .get() ?? DEFAULT_TOOL_SETTINGS
    );
  }

  set(userId: string, settings: ToolSettings, now: number): ToolSettings {
    this.#database
      .update(toolSettings)
      .set({ ...settings, ...updatedAuditFields(userId, now) })
      .where(activeSettingsCondition(userId))
      .run();
    const updated = sqliteChangeCount(
      this.#database,
      "The tool settings update count is unavailable",
    );
    if (updated === 0) {
      this.#database
        .insert(toolSettings)
        .values({
          ...createdAuditFields(userId, now),
          ...settings,
          id: this.#idAt(now),
          userId,
        })
        .run();
    }
    return settings;
  }
}
