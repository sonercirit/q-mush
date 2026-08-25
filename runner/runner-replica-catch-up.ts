import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountExport } from "../shared/account-export.ts";
import { ACCOUNT_EXPORT_ENTITIES } from "../shared/account-export.ts";
import { createRunnerReplicaStore } from "./runner-replica-store.ts";

export interface CatchUpSource {
  readonly inventory: () => Promise<Omit<AccountExport, "blobs">>;
  readonly blob: (digest: string) => Promise<Uint8Array>;
}

export async function catchUpRunnerReplica(
  directory: string,
  source: CatchUpSource,
  availableBytes: number,
) {
  const store = createRunnerReplicaStore(directory);
  try {
    const inventory = await source.inventory();
    const requiredBytes = inventory.manifest.reduce(
      (total, entry) => total + entry.size,
      0,
    );
    store.begin({ availableBytes, requiredBytes });
    const exportedEntities = new Set(inventory.entities);
    if (
      ACCOUNT_EXPORT_ENTITIES.some((entity) => !exportedEntities.has(entity))
    ) {
      throw new Error("Replica inventory is scoped or metadata-only");
    }
    store.applyRecords(inventory.records);
    store.setManifest(inventory.manifest);
    mkdirSync(join(directory, "incoming"), { recursive: true });
    for (const entry of store.missingBlobs()) {
      const path = join(directory, "incoming", entry.digest);
      writeFileSync(path, await source.blob(entry.digest));
      await store.installBlob(path);
    }
    store.setFrontier(inventory.frontier);
    return store.progress();
  } finally {
    store.close();
  }
}
