import type {
  EngineHealthReason,
  EngineHealthSnapshot,
} from "../shared/engine-health.ts";

const STORAGE_HEALTH_MESSAGES: Readonly<Record<EngineHealthReason, string>> = {
  database_corrupt:
    "The database integrity check failed. Q Mush retained every repair snapshot; restore or repair the database before relying on new saves.",
  disk_full:
    "The database volume is full. Critical saves fail after brief bounded retries; free disk space to restore persistence.",
  low_disk_space:
    "Database storage is running low. Free disk space to preserve maintenance headroom.",
};

export function storageHealthWarning(
  health: EngineHealthSnapshot | undefined,
): string | undefined {
  return health?.degraded
    ? health.reasons.map((reason) => STORAGE_HEALTH_MESSAGES[reason]).join(" ")
    : undefined;
}
