import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { utf8Prefix } from "../shared/utf8.ts";

const MAXIMUM_TOOL_OUTPUT_BYTES = 50 * 1_024;
export const MAXIMUM_TOOL_OUTPUT_LINES = 2_000;

interface TruncatedToolOutput {
  readonly output: string;
  readonly shownLines: number;
  readonly truncated: boolean;
}

function boundedLineOutput(
  lines: readonly string[],
  maximumLines = MAXIMUM_TOOL_OUTPUT_LINES,
  partialFirstLine = true,
): TruncatedToolOutput {
  let shownLines = Math.min(lines.length, maximumLines);
  let output = lines.slice(0, shownLines).join("\n");
  while (
    shownLines > 0 &&
    Buffer.byteLength(output, "utf8") > MAXIMUM_TOOL_OUTPUT_BYTES
  ) {
    shownLines -= 1;
    output = lines.slice(0, shownLines).join("\n");
  }
  if (shownLines === 0 && lines.length > 0 && partialFirstLine) {
    output = utf8Prefix(lines[0] ?? "", MAXIMUM_TOOL_OUTPUT_BYTES);
    shownLines = 1;
  }
  return {
    output,
    shownLines,
    truncated:
      shownLines < lines.length ||
      output !== lines.slice(0, shownLines).join("\n"),
  };
}

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
  const shown = boundedLineOutput(
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
    const bounded = boundedLineOutput(output.split("\n"));
    if (!bounded.truncated) {
      return output;
    }

    const spillPath = await this.#writeSpill(output);
    const notice = `Output exceeds the per-call limit (${String(MAXIMUM_TOOL_OUTPUT_LINES)} lines or ${String(MAXIMUM_TOOL_OUTPUT_BYTES)} bytes). The full output has been saved to ${spillPath}. Use the read tool with offset/limit to continue.`;
    return bounded.output.length === 0
      ? notice
      : `${bounded.output}\n\n${notice}`;
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
