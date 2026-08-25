import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ACCOUNT_EXPORT_ENTITIES,
  accountExportFrontier,
  isAccountExportInventory,
  type AccountExport,
} from "../../shared/account-export.ts";
import { sha256 } from "../../shared/sha256.ts";
import {
  catchUpRunnerReplica,
  type CatchUpSource,
} from "../runner-replica-catch-up.ts";

const bytes = new TextEncoder().encode("attachment bytes");
const digest = sha256(bytes);
const inventoryBase = {
  entities: ACCOUNT_EXPORT_ENTITIES,
  entityCounts: Object.fromEntries(
    ACCOUNT_EXPORT_ENTITIES.map((entity) => [
      entity,
      entity === "agent_messages" ? 1 : 0,
    ]),
  ),
  manifest: [{ digest, size: bytes.length }],
  records: [
    { entity: "agent_messages", id: "m", payload: "{}", tombstone: false },
  ],
};
const inventory: Omit<AccountExport, "blobs"> = {
  ...inventoryBase,
  frontier: accountExportFrontier(inventoryBase),
};

function createDirectory(): string {
  return mkdtempSync(join(tmpdir(), "catch-up-"));
}

function createSource(blob: CatchUpSource["blob"]): CatchUpSource {
  return { blob, inventory: () => Promise.resolve(inventory) };
}

async function catchUp(
  directory: string,
  source: CatchUpSource,
  availableBytes = 20_000_000,
) {
  return catchUpRunnerReplica(directory, source, availableBytes);
}

test("catch-up resumes missing blobs and becomes ready only after verified bytes", async () => {
  const directory = createDirectory();
  let interrupted = true;
  const resumableSource = createSource(() => {
    if (interrupted) return Promise.reject(new Error("interrupted"));
    return Promise.resolve(bytes);
  });

  await expect(catchUp(directory, resumableSource)).rejects.toThrow(
    "interrupted",
  );
  interrupted = false;
  await expect(catchUp(directory, resumableSource)).resolves.toMatchObject({
    state: "ready",
  });
  expect(readFileSync(join(directory, "blobs", digest))).toEqual(
    Buffer.from(bytes),
  );
});

test("frontier checksum rejects a mutated inventory", () => {
  expect(
    isAccountExportInventory({
      ...inventory,
      records: [
        {
          entity: "agent_messages",
          id: "changed",
          payload: "{}",
          tombstone: false,
        },
      ],
    }),
  ).toBe(false);
});

test("scoped or metadata-only inventory cannot become ready", async () => {
  const source: CatchUpSource = {
    blob: () => Promise.resolve(bytes),
    inventory: () => Promise.resolve({ ...inventory, entities: ["users"] }),
  };

  await expect(catchUp(createDirectory(), source)).rejects.toThrow(
    "scoped or metadata-only",
  );
});
test("low disk rejects without claiming readiness", async () => {
  const source = createSource(() => Promise.resolve(bytes));

  await expect(
    catchUp(createDirectory(), source, bytes.length - 1),
  ).rejects.toThrow("Insufficient replica capacity");
});
