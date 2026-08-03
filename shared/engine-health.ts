export type EngineHealthReason =
  "database_corrupt" | "disk_full" | "low_disk_space";

export interface EngineHealthSnapshot {
  readonly degraded: boolean;
  readonly reasons: readonly EngineHealthReason[];
}
