import {
  accountExportBlobResponse,
  findAccountExportBlob,
  type AccountExportBlob,
} from "../shared/account-export.ts";

export function runnerExportBlobResponse(
  blob: AccountExportBlob | undefined,
  range?: string | null,
): Response {
  return accountExportBlobResponse(
    findAccountExportBlob(
      blob === undefined ? undefined : [blob],
      blob?.digest ?? "",
    ),
    range,
  );
}
