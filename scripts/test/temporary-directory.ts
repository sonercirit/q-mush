import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

export async function waitForTemporaryFileContent(
  pathname: string,
  content: string,
): Promise<void> {
  await expect
    .poll(async () => (await Bun.file(pathname).text()).includes(content), {
      interval: 10,
      timeout: 5_000,
    })
    .toBe(true);
}

export async function withTemporaryDirectory<Result>(
  prefix: string,
  run: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
