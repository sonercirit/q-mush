import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  applyToolOutputNotice,
  boundedToolOutput,
  boundedToolOutputLines,
  MAXIMUM_TOOL_OUTPUT_BYTES,
  MAXIMUM_TOOL_OUTPUT_LINES,
  toolOutputLimitNotice,
} from "../shared/tool-output-limits.ts";

export function readContinuation(
  content: string,
  offset: number,
  limit: number,
): string {
  const lines = content.split("\n");
  const start = offset - 1;
  if (start >= lines.length) {
    throw new Error(
      `Offset ${String(offset)} is beyond end of file (${String(lines.length)} lines total)`,
    );
  }
  const requested = lines.slice(start, start + limit);
  const shown = boundedToolOutputLines(
    requested,
    Math.min(limit, MAXIMUM_TOOL_OUTPUT_LINES),
    false,
  );
  if (shown.shownLines === 0 && requested.length > 0) {
    return `[Line ${String(offset)} exceeds the ${String(MAXIMUM_TOOL_OUTPUT_BYTES / 1_024)}KB read limit. Use offset/limit on the same file or bash to read a bounded segment.]`;
  }
  const nextOffset = start + shown.shownLines + 1;
  return nextOffset <= lines.length
    ? `${shown.output}\n\n[Showing lines ${String(offset)}-${String(nextOffset - 1)} of ${String(lines.length)}. Use offset=${String(nextOffset)} to continue.]`
    : limit >= lines.length && offset === 1
      ? content
      : shown.output;
}

export class RunnerOutputSpills {
  readonly #spillPaths = new Set<string>();
  readonly #temporaryRoot = resolve(tmpdir());
  #directory: Promise<string> | undefined;
  #spillSequence = 0;

  async apply(output: string): Promise<string> {
    if (!boundedToolOutput(output).truncated) {
      return output;
    }
    const notice = toolOutputLimitNotice(await this.#writeSpill(output));
    return applyToolOutputNotice(output, notice);
  }

  async spill(output: string): Promise<string> {
    return this.#writeSpill(output);
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
    if (directory !== undefined) {
      await rm(await directory, { force: true, recursive: true });
    }
  }

  #spillDirectory(): Promise<string> {
    this.#directory ??= mkdtemp(join(tmpdir(), "q-mush-tool-output-"));
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
