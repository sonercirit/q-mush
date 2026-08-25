import { statfsSync } from "node:fs";
import {
  completeAccountExportInventory,
  isAccountExportInventory,
  type AccountExportInventory,
  type AccountExportRecord,
} from "../shared/account-export.ts";
import { isSha256Digest } from "../shared/digest.ts";
import {
  RUNNER_ACCOUNT_EXPORT_BLOB_PATH,
  RUNNER_ACCOUNT_EXPORT_PATH,
} from "../shared/routes.ts";
import { isRecord } from "../shared/validation.ts";
import { catchUpRunnerReplica } from "./runner-replica-catch-up.ts";

function isExportRecord(value: unknown): value is AccountExportRecord {
  return (
    isRecord(value) &&
    typeof value["entity"] === "string" &&
    typeof value["id"] === "string" &&
    typeof value["payload"] === "string" &&
    typeof value["tombstone"] === "boolean"
  );
}
interface ExportBlobEntry {
  readonly digest: string;
  readonly size: number;
}
function isBlobEntry(value: unknown): value is ExportBlobEntry {
  return (
    isRecord(value) &&
    isSha256Digest(value["digest"]) &&
    typeof value["size"] === "number"
  );
}
export async function catchUpAccountExport(
  directory: string,
  configurationPath: string,
  serverOrigin: string,
  token: string,
): Promise<void> {
  const authorization = `Bearer ${token}`;
  const records: AccountExportRecord[] = [];
  const manifest: Record<string, number> = {};
  let offset = 0;
  let done = false;
  while (!done) {
    const response = await fetch(
      `${serverOrigin}${RUNNER_ACCOUNT_EXPORT_PATH}?offset=${String(offset)}`,
      { headers: { authorization } },
    );
    if (!response.ok)
      throw new Error(`Replica catch-up failed (${String(response.status)})`);
    const page: unknown = await response.json();
    if (
      typeof page !== "object" ||
      page === null ||
      !("records" in page) ||
      !Array.isArray(page.records) ||
      !page.records.every(isExportRecord) ||
      !("blobs" in page) ||
      !Array.isArray(page.blobs) ||
      !page.blobs.every(isBlobEntry) ||
      !("done" in page) ||
      typeof page.done !== "boolean" ||
      !("nextOffset" in page) ||
      typeof page.nextOffset !== "number"
    )
      throw new Error("The account export response is invalid");
    records.push(...page.records);
    for (const entry of page.blobs) manifest[entry.digest] = entry.size;
    done = page.done;
    if (done) continue;
    if (page.nextOffset <= offset)
      throw new Error("The account export cursor did not advance");
    offset = page.nextOffset;
  }
  const value: AccountExportInventory = completeAccountExportInventory(
    records,
    Object.entries(manifest).map(([digest, size]) => ({ digest, size })),
  );
  if (!isAccountExportInventory(value))
    throw new Error("The assembled account export is invalid");
  const filesystem = statfsSync(configurationPath);
  await catchUpRunnerReplica(
    directory,
    {
      inventory: () => Promise.resolve(value),
      blob: async (digest, offset) => {
        const blobResponse = await fetch(
          `${serverOrigin}${RUNNER_ACCOUNT_EXPORT_BLOB_PATH}/${digest}`,
          {
            headers: {
              authorization,
              ...(offset > 0 && { range: `bytes=${String(offset)}-` }),
            },
          },
        );
        if (!blobResponse.ok)
          throw new Error(
            `Replica blob download failed (${String(blobResponse.status)})`,
          );
        if (offset > 0 && blobResponse.status !== 206)
          throw new Error("Replica blob server did not honor the resume range");
        return new Uint8Array(await blobResponse.arrayBuffer());
      },
    },
    filesystem.bavail * filesystem.bsize,
  );
}
