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

async function runCatchUpServer(
  prefix: string,
  fetch: (request: Request) => Response,
  prepare?: (directory: string) => void,
): Promise<void> {
  const server = Bun.serve({ fetch, port: 0 });
  const directory = mkdtempSync(join(tmpdir(), prefix));
  prepare?.(directory);
  const configurationPath = join(directory, "runner.json");
  writeFileSync(configurationPath, "{}");
  try {
    await catchUpAccountExport(
      directory,
      configurationPath,
      server.url.origin,
      "token",
    );
  } finally {
    void server.stop(true);
  }
}

function requestPath(request: Request): string {
  return new URL(request.url).pathname;
}

function blobTransferResponse(
  request: Request,
  bytes: Uint8Array,
  digest: string,
): Response {
  return accountExportBlobResponse(
    { data: bytes.toBase64(), digest, size: bytes.length },
    request.headers.get("range"),
  );
}

test("restarts pagination when the account changes between pages", async () => {
  const bytes = new TextEncoder().encode("stable export");
  const digest = sha256(bytes);
  const revisions = ["1".repeat(64), "2".repeat(64), "2".repeat(64)];
  const offsets: number[] = [];
  await runCatchUpServer("account-export-restart-", (request) => {
    const url = new URL(request.url);
    const exportRequest = url.pathname === RUNNER_ACCOUNT_EXPORT_PATH;
    if (exportRequest) {
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      const revision = revisions.shift() ?? "2".repeat(64);
      return Response.json({
        blobs: offset === 0 ? [{ digest, size: bytes.length }] : [],
        done: revision === "2".repeat(64) && offset > 0,
        nextOffset: offset + 1,
        records: [
          {
            entity: "users",
            id: `${revision}-${String(offset)}`,
            payload: JSON.stringify({ id: `${revision}-${String(offset)}` }),
            tombstone: false,
          },
        ],
        revision,
      });
    }
    if (url.pathname === `${RUNNER_ACCOUNT_EXPORT_BLOB_PATH}/${digest}`)
      return blobTransferResponse(request, bytes, digest);
    return new Response("Not found", { status: 404 });
  });
  expect(offsets).toEqual([0, 1, 0, 1]);
});

test("bounds revision-change restarts with a progress diagnostic", async () => {
  let requests = 0;
  await expect(
    runCatchUpServer("account-export-unstable-", (request) => {
      if (requestPath(request) !== RUNNER_ACCOUNT_EXPORT_PATH)
        return new Response("Not found", { status: 404 });
      requests += 1;
      const offset = Number(new URL(request.url).searchParams.get("offset"));
      return Response.json({
        blobs: [],
        done: false,
        nextOffset: offset + 1,
        records: [
          {
            entity: "users",
            id: String(requests),
            payload: JSON.stringify({ id: String(requests) }),
            tombstone: false,
          },
        ],
        revision: String(requests).padStart(64, "0"),
      });
    }),
  ).rejects.toThrow(
    "Replica catch-up did not stabilize after 4 revision changes (last offset 1)",
  );
  expect(requests).toBe(8);
});

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
  await runCatchUpServer(
    "account-export-http-",
    (request) => {
      const pathname = requestPath(request);
      if (pathname === RUNNER_ACCOUNT_EXPORT_PATH)
        return Response.json({
          blobs: inventory.manifest,
          done: true,
          nextOffset: 0,
          revision: "0".repeat(64),
          records: inventory.records,
        });
      if (pathname === `${RUNNER_ACCOUNT_EXPORT_BLOB_PATH}/${digest}`) {
        receivedRange = request.headers.get("range");
        return blobTransferResponse(request, bytes, digest);
      }
      return new Response("Not found", { status: 404 });
    },
    (directory) => {
      mkdirSync(join(directory, "incoming"));
      writeFileSync(join(directory, "incoming", digest), bytes.slice(0, 9));
    },
  );
  expect(receivedRange).toBe("bytes=9-");
});
