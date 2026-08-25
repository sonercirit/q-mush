import {
  accountExportBlobResponse,
  findAccountExportBlob,
  type AccountExport,
} from "../shared/account-export.ts";
import { activeViewQuery } from "../shared/active-view-query.ts";
import { parseJsonRecord } from "../shared/json-record.ts";
import {
  RUNNER_ACCOUNT_EXPORT_BLOB_PATH,
  RUNNER_ACCOUNT_EXPORT_PATH,
} from "../shared/routes.ts";

export function activeViewResponse(
  exported: AccountExport,
  url: URL,
): Response {
  const { entity, limit } = activeViewQuery(url);
  if (
    (entity !== "agent_messages" && entity !== "agent_sessions") ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    return new Response("Invalid active view", { status: 400 });
  const sessionId = url.searchParams.get("sessionId");
  const matching = exported.records
    .filter((record) => record.entity === entity && !record.tombstone)
    .map((record) =>
      parseJsonRecord(record.payload, "Invalid active view record"),
    )
    .filter(
      (record) => sessionId === null || record["session_id"] === sessionId,
    );
  return Response.json({
    complete: matching.length <= limit,
    partial: true,
    records: matching.slice(0, limit),
  });
}

export function runnerExportResponse(
  exported: AccountExport,
  pathname: string,
): Response {
  if (pathname === RUNNER_ACCOUNT_EXPORT_PATH)
    return Response.json({
      entities: exported.entities,
      entityCounts: exported.entityCounts,
      frontier: exported.frontier,
      manifest: exported.manifest,
      records: exported.records,
    });
  const digest = pathname.slice(RUNNER_ACCOUNT_EXPORT_BLOB_PATH.length + 1);
  return accountExportBlobResponse(
    findAccountExportBlob(exported.blobs, digest),
  );
}
