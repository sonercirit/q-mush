import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ACCOUNT_EXPORT_ENTITIES,
  accountExportBlobResponse,
  accountExportFrontier,
  type AccountExportRecord,
} from "../../shared/account-export.ts";
import {
  RUNNER_ACCOUNT_EXPORT_BLOB_PATH,
  RUNNER_ACCOUNT_EXPORT_PATH,
} from "../../shared/routes.ts";
import { sha256 } from "../../shared/sha256.ts";
import {
  catchUpAccountExport,
  type AccountExportRetryHandler,
} from "../runner-account-export-client.ts";

async function runCatchUpServer(
  prefix: string,
  fetch: (request: Request) => Response,
  prepare?: (directory: string) => void,
  onRetry?: AccountExportRetryHandler,
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
      onRetry,
    );
  } finally {
    void server.stop(true);
  }
}

function requestPath(request: Request): string {
  return new URL(request.url).pathname;
}

function exportRecord(id: string, payloadId = id): AccountExportRecord {
  return {
    entity: "users",
    id,
    tombstone: false,
    payload: JSON.stringify({ id: payloadId }),
  };
}

function missingRoute(): Response {
  return new Response("Not found", { status: 404 });
}

function revisionDigest(value: number): string {
  return String(value).padStart(64, "0");
}

function exportPageResponse(
  requests: number,
  revisionNumber: number,
  done: boolean,
): Response {
  return Response.json({
    blobs: [],
    done,
    ...(!done && { nextCursor: `next-${String(requests)}` }),
    records: [exportRecord(String(requests))],
    revision: revisionDigest(revisionNumber),
  });
}

function createExportRequestCounter(): (
  request: Request,
) => number | undefined {
  let requests = 0;
  return (request) => {
    if (requestPath(request) !== RUNNER_ACCOUNT_EXPORT_PATH) return undefined;
    requests += 1;
    return requests;
  };
}

function exportRequestHandler(
  handler: (request: Request, requestNumber: number) => Response,
): (request: Request) => Response {
  const nextRequest = createExportRequestCounter();
  return (request) => {
    const requestNumber = nextRequest(request);
    return requestNumber === undefined
      ? missingRoute()
      : handler(request, requestNumber);
  };
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
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      offsets.push(offset);
      const revision = revisions.shift() ?? "2".repeat(64);
      return Response.json({
        blobs: offset === 0 ? [{ digest, size: bytes.length }] : [],
        nextCursor: String(offset + 1),
        done: revision.endsWith("2") && offset > 0,
        records: [exportRecord(`${revision}-${String(offset)}`)],
        revision,
      });
    }
    if (url.pathname === `${RUNNER_ACCOUNT_EXPORT_BLOB_PATH}/${digest}`)
      return blobTransferResponse(request, bytes, digest);
    return missingRoute();
  });
  expect(offsets).toEqual([0, 1, 0, 1]);
});

test("reports every revision restart with cumulative progress", async () => {
  const progress: Parameters<AccountExportRetryHandler>[0][] = [];
  await runCatchUpServer(
    "account-export-progress-",
    exportRequestHandler((request, requests) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      const revisionNumber = Math.min(Math.ceil(requests / 2), 3);
      return exportPageResponse(
        requests,
        revisionNumber,
        cursor !== null && revisionNumber === 3,
      );
    }),
    undefined,
    (event) => progress.push(event),
  );
  expect(progress).toHaveLength(2);
  expect(progress.map(({ restartCount }) => restartCount)).toEqual([1, 2]);
  expect(progress[0]).toMatchObject({
    previousRevision: revisionDigest(1),
    revision: revisionDigest(2),
  });
  expect(progress[1]?.elapsedMilliseconds).toBeGreaterThanOrEqual(
    progress[0]?.elapsedMilliseconds ?? 0,
  );
});

test("converges after sustained revision changes during pagination", async () => {
  let finalRequest = 0;
  const offsets: number[] = [];
  await runCatchUpServer(
    "account-export-unstable-",
    exportRequestHandler((request, requests) => {
      finalRequest = requests;
      const offset = Number(
        new URL(request.url).searchParams.get("cursor") ?? "0",
      );
      offsets.push(offset);
      const revisionNumber = Math.min(requests, 10);
      return Response.json({
        blobs: [],
        nextCursor: String(offset + 1),
        done: offset > 0 && revisionNumber >= 10,
        records: [
          exportRecord(
            `${String(revisionNumber)}-${String(offset)}`,
            String(revisionNumber),
          ),
        ],
        revision: revisionDigest(revisionNumber),
      });
    }),
  );
  expect(finalRequest).toBe(12);
  expect(offsets.filter((offset) => offset === 0)).toHaveLength(6);
  expect(offsets.at(-1)).toBe(1);
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
          nextCursor: undefined,
          revision: "0".repeat(64),
          records: inventory.records,
        });
      if (pathname === `${RUNNER_ACCOUNT_EXPORT_BLOB_PATH}/${digest}`) {
        receivedRange = request.headers.get("range");
        return blobTransferResponse(request, bytes, digest);
      }
      return missingRoute();
    },
    (directory) => {
      mkdirSync(join(directory, "incoming"));
      writeFileSync(join(directory, "incoming", digest), bytes.slice(0, 9));
    },
  );
  expect(receivedRange).toBe("bytes=9-");
});
