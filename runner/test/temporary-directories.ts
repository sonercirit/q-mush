import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

export interface FakeRunnerProcessCall {
  readonly arguments: readonly string[];
  readonly executable: string;
}

export function recordRunnerProcessCall(
  calls: FakeRunnerProcessCall[],
  executable: string,
  arguments_: readonly string[],
): void {
  calls.push({ arguments: arguments_, executable });
}

export function useTemporaryDirectories(prefix: string): () => Promise<string> {
  const paths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      paths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
  });

  return async () => {
    const path = await mkdtemp(join(tmpdir(), prefix));
    paths.push(path);
    return path;
  };
}
