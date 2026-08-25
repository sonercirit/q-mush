import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { isAccountExport } from "../shared/account-export.ts";
import { RUNNER_ACCOUNT_EXPORT_PATH } from "../shared/routes.ts";
import { catchUpRunnerReplica } from "./runner-replica-catch-up.ts";

export async function catchUpAccountExport(
  directory: string,
  configurationDirectory: string,
  serverOrigin: string,
  token: string,
): Promise<void> {
  const response = await fetch(`${serverOrigin}${RUNNER_ACCOUNT_EXPORT_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Replica catch-up failed (${String(response.status)})`);
  }
  const value: unknown = await response.json();
  if (!isAccountExport(value)) {
    throw new Error("The account export response is invalid");
  }
  const filesystem = statfsSync(dirname(configurationDirectory));
  await catchUpRunnerReplica(
    directory,
    {
      inventory: () =>
        Promise.resolve({
          entities: value.entities,
          frontier: value.frontier,
          manifest: value.manifest,
          records: value.records,
        }),
      blob: (digest) => {
        const blob = value.blobs.find((entry) => entry.digest === digest);
        if (blob === undefined)
          throw new Error("Replica blob is absent from export");
        return Promise.resolve(Uint8Array.fromBase64(blob.data));
      },
    },
    filesystem.bavail * filesystem.bsize,
  );
}
