import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ACCOUNT_EXPORT_ENTITIES,
  accountExportBlobResponse,
  accountExportFrontier,
} from "../../shared/account-export.ts";
import {
  RUNNER_ACCOUNT_EXPORT_BLOB_PATH,
  RUNNER_ACCOUNT_EXPORT_PATH,
} from "../../shared/routes.ts";
import { sha256 } from "../../shared/sha256.ts";
import { catchUpAccountExport } from "../runner-account-export-client.ts";

// Exercises fetch, HTTP Range, the persisted incoming file, and the shipped client.
test("account export client resumes a real HTTP blob transfer", async () => {
  const bytes = new TextEncoder().encode("a resumable attachment payload");
  const digest = sha256(bytes);
  const emptyCounts: Record<string, number> = {};
  for (const entity of ACCOUNT_EXPORT_ENTITIES) emptyCounts[entity] = 0;
  const base = {
    entities: ACCOUNT_EXPORT_ENTITIES,
    entityCounts: emptyCounts,
    manifest: [{ digest, size: bytes.length }],
    records: [],
  };
  const inventory = { ...base, frontier: accountExportFrontier(base) };
  let receivedRange: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === RUNNER_ACCOUNT_EXPORT_PATH)
        return Response.json({
          blobs: inventory.manifest,
          done: true,
          nextOffset: 0,
          records: inventory.records,
        });
      if (url.pathname === `${RUNNER_ACCOUNT_EXPORT_BLOB_PATH}/${digest}`) {
        receivedRange = request.headers.get("range");
        return accountExportBlobResponse(
          { data: bytes.toBase64(), digest, size: bytes.length },
          receivedRange,
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const directory = mkdtempSync(join(tmpdir(), "account-export-http-"));
  mkdirSync(join(directory, "incoming"));
  writeFileSync(join(directory, "incoming", digest), bytes.slice(0, 9));
  const configurationPath = join(directory, "runner.json");
  writeFileSync(configurationPath, "{}");
  try {
    await catchUpAccountExport(
      directory,
      configurationPath,
      server.url.origin,
      "token",
    );
    expect(receivedRange).toBe("bytes=9-");
  } finally {
    void server.stop(true);
  }
});
