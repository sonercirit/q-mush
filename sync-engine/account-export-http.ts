import {
  accountExportBlobResponse,
  findAccountExportBlob,
  type AccountExport,
} from "../shared/account-export.ts";
import {
  RUNNER_ACCOUNT_EXPORT_BLOB_PATH,
  RUNNER_ACCOUNT_EXPORT_PATH,
} from "../shared/routes.ts";
export function runnerExportResponse(
  exported: AccountExport,
  pathname: string,
  range?: string | null,
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
    range,
  );
}
