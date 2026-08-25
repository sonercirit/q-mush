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

const MAX_EXPORT_RESTARTS = 3;
const EXPORT_RESTART_BACKOFF_MILLISECONDS = 100;

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
  let manifest: Record<string, number> = {};
  let offset = 0;
  let done = false;
  let revision: string | undefined;
  let restarts = 0;
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
      !("revision" in page) ||
      !isSha256Digest(page.revision) ||
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
    if (revision !== undefined && revision !== page.revision) {
      restarts += 1;
      if (restarts > MAX_EXPORT_RESTARTS)
        throw new Error(
          `Replica catch-up did not stabilize after ${String(restarts)} revision changes (last offset ${String(offset)})`,
        );
      records.length = 0;
      manifest = {};
      offset = 0;
      done = false;
      revision = undefined;
      await Bun.sleep(EXPORT_RESTART_BACKOFF_MILLISECONDS * restarts);
      continue;
    }
    revision = page.revision;
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
