import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

export function useSynchronousTemporaryDirectories(
  prefix: string,
): () => string {
  const paths = new Set<string>();

  afterEach(() => {
    for (const path of paths) {
      rmSync(path, { force: true, recursive: true });
    }
    paths.clear();
  });

  return () => {
    const path = mkdtempSync(join(tmpdir(), prefix));
    paths.add(path);
    return path;
  };
}
