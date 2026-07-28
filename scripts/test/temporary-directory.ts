import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTemporaryDirectory(
  prefix: string,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
