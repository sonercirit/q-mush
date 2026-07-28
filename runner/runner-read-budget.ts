import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { utf8Prefix } from "../shared/utf8.ts";

const MAXIMUM_GLOBAL_READ_OUTPUT_BYTES = 50 * 1_024;

export class RunnerReadBudget {
  readonly #spillPaths = new Set<string>();
  readonly #temporaryRoot = resolve(tmpdir());
  #directory: Promise<string> | undefined;
  #spillSequence = 0;
  #usedBytes = 0;

  async apply(output: string): Promise<string> {
    const outputBytes = Buffer.byteLength(output, "utf8");
    if (this.#usedBytes + outputBytes <= MAXIMUM_GLOBAL_READ_OUTPUT_BYTES) {
      this.#usedBytes += outputBytes;
      return output;
    }

    const remainingBytes = Math.max(
      0,
      MAXIMUM_GLOBAL_READ_OUTPUT_BYTES - this.#usedBytes,
    );
    this.#usedBytes += remainingBytes;
    const spillPath = await this.#writeSpill(output);
    const prefix = utf8Prefix(output, remainingBytes);
    const notice = `Output exceeds the global read limit (${String(MAXIMUM_GLOBAL_READ_OUTPUT_BYTES)} bytes). The full output has been saved to ${spillPath}. Read that file with offset/limit to continue.`;
    return prefix.length === 0 ? notice : `${prefix}\n\n${notice}`;
  }

  isSpillPath(path: string): boolean {
    return this.#spillPaths.has(resolve(path));
  }

  ownsPath(path: string): boolean {
    const canonical = resolve(path);
    return (
      this.#spillPaths.has(canonical) &&
      (canonical === this.#temporaryRoot ||
        canonical.startsWith(`${this.#temporaryRoot}/`))
    );
  }

  async cleanup(): Promise<void> {
    const directory = this.#directory;
    this.#directory = undefined;
    this.#spillPaths.clear();
    this.#usedBytes = 0;
    if (directory !== undefined) {
      await rm(await directory, { force: true, recursive: true });
    }
  }

  #spillDirectory(): Promise<string> {
    this.#directory ??= mkdtemp(join(tmpdir(), "q-mush-read-"));
    return this.#directory;
  }

  async #writeSpill(content: string): Promise<string> {
    const directory = await this.#spillDirectory();
    this.#spillSequence += 1;
    const path = join(directory, `output-${String(this.#spillSequence)}.txt`);
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    this.#spillPaths.add(resolve(path));
    return path;
  }
}
