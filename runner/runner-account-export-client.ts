import { statfsSync } from "node:fs";
import { isAccountExportInventory } from "../shared/account-export.ts";
import {
  RUNNER_ACCOUNT_EXPORT_BLOB_PATH,
  RUNNER_ACCOUNT_EXPORT_PATH,
} from "../shared/routes.ts";
import { catchUpRunnerReplica } from "./runner-replica-catch-up.ts";

export async function catchUpAccountExport(
  directory: string,
  configurationPath: string,
  serverOrigin: string,
  token: string,
): Promise<void> {
  const authorization = `Bearer ${token}`;
  const response = await fetch(`${serverOrigin}${RUNNER_ACCOUNT_EXPORT_PATH}`, {
    headers: { authorization },
  });
  if (!response.ok)
    throw new Error(`Replica catch-up failed (${String(response.status)})`);
  const value: unknown = await response.json();
  if (!isAccountExportInventory(value))
    throw new Error("The account export response is invalid");
  const filesystem = statfsSync(configurationPath);
  await catchUpRunnerReplica(
    directory,
    {
      inventory: () => Promise.resolve(value),
      blob: async (digest) => {
        const blobResponse = await fetch(
          `${serverOrigin}${RUNNER_ACCOUNT_EXPORT_BLOB_PATH}/${digest}`,
          { headers: { authorization } },
        );
        if (!blobResponse.ok)
          throw new Error(
            `Replica blob download failed (${String(blobResponse.status)})`,
          );
        return new Uint8Array(await blobResponse.arrayBuffer());
      },
    },
    filesystem.bavail * filesystem.bsize,
  );
}
