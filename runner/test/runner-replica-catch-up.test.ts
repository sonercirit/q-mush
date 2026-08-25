import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AccountExport } from "../../shared/account-export.ts";
import { ACCOUNT_EXPORT_ENTITIES } from "../../shared/account-export.ts";
import { sha256 } from "../../shared/sha256.ts";
import {
  catchUpRunnerReplica,
  type CatchUpSource,
} from "../runner-replica-catch-up.ts";

const bytes = new TextEncoder().encode("attachment bytes");
const digest = sha256(bytes);
const inventory: Omit<AccountExport, "blobs"> = {
  entities: ACCOUNT_EXPORT_ENTITIES,
  frontier: "complete-frontier",
  manifest: [{ digest, size: bytes.length }],
  records: [
    { entity: "agent_messages", id: "m", payload: "{}", tombstone: false },
  ],
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
  availableBytes = 100,
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
