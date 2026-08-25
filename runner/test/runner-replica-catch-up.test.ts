import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AccountExport } from "../../shared/account-export.ts";
import { catchUpRunnerReplica } from "../runner-replica-catch-up.ts";

const bytes = new TextEncoder().encode("attachment bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const inventory: Omit<AccountExport, "blobs"> = {
  frontier: "complete-frontier",
  manifest: [{ digest, size: bytes.length }],
  records: [
    { entity: "agent_messages", id: "m", payload: "{}", tombstone: false },
  ],
};

test("catch-up resumes missing blobs and becomes ready only after verified bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "catch-up-"));
  let interrupted = true;
  await expect(
    catchUpRunnerReplica(
      directory,
      {
        inventory: () => Promise.resolve(inventory),
        blob: () => {
          if (interrupted) return Promise.reject(new Error("interrupted"));
          return Promise.resolve(bytes);
        },
      },
      100,
    ),
  ).rejects.toThrow("interrupted");
  interrupted = false;
  await expect(
    catchUpRunnerReplica(
      directory,
      {
        inventory: () => Promise.resolve(inventory),
        blob: () => Promise.resolve(bytes),
      },
      100,
    ),
  ).resolves.toMatchObject({ state: "ready" });
  expect(readFileSync(join(directory, "blobs", digest))).toEqual(
    Buffer.from(bytes),
  );
});

test("low disk rejects without claiming readiness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "catch-up-"));
  await expect(
    catchUpRunnerReplica(
      directory,
      {
        inventory: () => Promise.resolve(inventory),
        blob: () => Promise.resolve(bytes),
      },
      bytes.length - 1,
    ),
  ).rejects.toThrow("Insufficient replica capacity");
});
