import {
  accountExportBlobResponse,
  type AccountExportBlob,
} from "../shared/account-export.ts";

export function runnerExportBlobResponse(
  blob: AccountExportBlob | undefined,
  range?: string | null,
): Response {
  return accountExportBlobResponse(blob, range);
}
