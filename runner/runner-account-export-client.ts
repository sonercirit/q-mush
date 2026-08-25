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

const EXPORT_RESTART_BACKOFF_MILLISECONDS = 100;
const MAX_EXPORT_RESTART_BACKOFF_MILLISECONDS = 1_000;

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
export interface AccountExportRetryProgress {
  readonly elapsedMilliseconds: number;
  readonly previousRevision: string;
  readonly restartCount: number;
  readonly revision: string;
}
export type AccountExportRetryHandler = (
  progress: AccountExportRetryProgress,
) => void;
export async function catchUpAccountExport(
  directory: string,
  configurationPath: string,
  serverOrigin: string,
  token: string,
  onRetry?: AccountExportRetryHandler,
): Promise<void> {
  const startedAt = Date.now();
  const authorization = `Bearer ${token}`;
  const records: AccountExportRecord[] = [];
  let manifest: Record<string, number> = {};
  let cursor: string | undefined;
  let done = false;
  let revision: string | undefined;
  let restarts = 0;
  while (!done) {
    const response = await fetch(
      `${serverOrigin}${RUNNER_ACCOUNT_EXPORT_PATH}${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
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
      ("nextCursor" in page &&
        typeof page.nextCursor !== "string" &&
        page.nextCursor !== undefined) ||
      (!page.done &&
        (!("nextCursor" in page) || typeof page.nextCursor !== "string"))
    )
      throw new Error("The account export response is invalid");
    if (revision !== undefined && revision !== page.revision) {
      const previousRevision = revision;
      restarts += 1;
      onRetry?.({
        elapsedMilliseconds: Date.now() - startedAt,
        previousRevision,
        restartCount: restarts,
        revision: page.revision,
      });
      records.length = 0;
      manifest = {};
      cursor = undefined;
      done = false;
      revision = undefined;
      await Bun.sleep(
        Math.min(
          MAX_EXPORT_RESTART_BACKOFF_MILLISECONDS,
          EXPORT_RESTART_BACKOFF_MILLISECONDS * restarts,
        ),
      );
      continue;
    }
    const nextCursor =
      "nextCursor" in page && typeof page.nextCursor === "string"
        ? page.nextCursor
        : undefined;
    revision = page.revision;
    records.push(...page.records);
    for (const entry of page.blobs) manifest[entry.digest] = entry.size;
    done = page.done;
    if (done) continue;
    if (nextCursor === undefined || nextCursor === cursor)
      throw new Error("The account export cursor did not advance");
    cursor = nextCursor;
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
