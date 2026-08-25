import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_EXPORT_ENTITIES,
  accountExportEntityCounts,
  accountExportFrontier,
  type AccountExportInventory,
} from "../shared/account-export.ts";
import { createRunnerReplicaStore } from "./runner-replica-store.ts";

export interface CatchUpSource {
  readonly inventory: () => Promise<AccountExportInventory>;
  readonly blob: (digest: string) => Promise<Uint8Array>;
}

function requiredCapacity(inventory: AccountExportInventory): number {
  const recordBytes = new TextEncoder().encode(
    JSON.stringify(inventory),
  ).byteLength;
  const blobBytes = inventory.manifest.reduce(
    (total, entry) => total + entry.size,
    0,
  );
  const sqliteAndOperationalReserve = Math.max(
    16 * 1024 * 1024,
    recordBytes * 3,
  );
  return recordBytes + blobBytes * 2 + sqliteAndOperationalReserve;
}

export async function catchUpRunnerReplica(
  directory: string,
  source: CatchUpSource,
  availableBytes: number,
) {
  const store = createRunnerReplicaStore(directory);
  try {
    const inventory = await source.inventory();
    store.begin({ availableBytes, requiredBytes: requiredCapacity(inventory) });
    const exportedEntities = new Set(inventory.entities);
    const actualCounts = accountExportEntityCounts(inventory.records);
    if (
      ACCOUNT_EXPORT_ENTITIES.some(
        (entity) =>
          !exportedEntities.has(entity) ||
          inventory.entityCounts[entity] !== actualCounts[entity],
      )
    ) {
      throw new Error("Replica inventory is scoped or metadata-only");
    }
    const calculated = accountExportFrontier(inventory);
    if (calculated !== inventory.frontier)
      throw new Error("Replica inventory checksum is invalid");
    store.applyRecords(inventory.records);
    store.setManifest(inventory.manifest);
    const incoming = join(directory, "incoming");
    mkdirSync(incoming, { recursive: true });
    for (const entry of store.missingBlobs()) {
      const path = join(incoming, entry.digest);
      writeFileSync(path, await source.blob(entry.digest));
      if (statSync(path).size !== entry.size)
        throw new Error("Replica blob size is invalid");
      await store.installBlob(path);
    }
    store.setFrontier(inventory.frontier, calculated);
    return store.progress();
  } finally {
    store.close();
  }
}
