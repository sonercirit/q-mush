import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface PrivateFileOptions {
  readonly mode: number;
  readonly prepare?: (path: string) => void;
}

export function replacePrivateFile(
  path: string,
  contents: Uint8Array | string,
  options: PrivateFileOptions,
): void {
  const temporaryPath = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporaryPath, contents, {
      flag: "wx",
      mode: options.mode,
    });
    options.prepare?.(temporaryPath);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function writePrivateJsonFile(path: string, value: unknown): void {
  replacePrivateFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
