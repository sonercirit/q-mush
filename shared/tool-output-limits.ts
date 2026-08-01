import { utf8ByteLength, utf8Prefix } from "./utf8.ts";

export const MAXIMUM_TOOL_OUTPUT_BYTES = 50 * 1_024;
export const MAXIMUM_TOOL_OUTPUT_LINES = 2_000;

export interface BoundedToolOutput {
  readonly output: string;
  readonly shownLines: number;
  readonly truncated: boolean;
}

export function boundedToolOutputLines(
  lines: readonly string[],
  maximumLines = MAXIMUM_TOOL_OUTPUT_LINES,
  partialFirstLine = true,
): BoundedToolOutput {
  let shownLines = Math.min(lines.length, maximumLines);
  let output = lines.slice(0, shownLines).join("\n");
  while (shownLines > 0 && utf8ByteLength(output) > MAXIMUM_TOOL_OUTPUT_BYTES) {
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

export function boundedToolOutput(output: string): BoundedToolOutput {
  return boundedToolOutputLines(output.split("\n"));
}

export function formatBoundedToolOutput(
  bounded: BoundedToolOutput,
  notice: string,
): string {
  return [bounded.output, notice]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function applyToolOutputNotice(output: string, notice: string): string {
  const bounded = boundedToolOutput(output);
  return bounded.truncated ? formatBoundedToolOutput(bounded, notice) : output;
}

export function toolOutputLimitNotice(spillPath: string): string {
  return `Output exceeds the per-call limit (${String(MAXIMUM_TOOL_OUTPUT_LINES)} lines or ${String(MAXIMUM_TOOL_OUTPUT_BYTES)} bytes). The full output has been saved to ${spillPath}. Use the read tool with offset/limit to continue.`;
}

export function hardTruncatedToolOutput(output: string): string {
  const notice = `Output exceeds the per-call limit (${String(MAXIMUM_TOOL_OUTPUT_LINES)} lines or ${String(MAXIMUM_TOOL_OUTPUT_BYTES)} bytes). The full output could not be saved because the session runner is unreachable; this output was hard-truncated.`;
  return applyToolOutputNotice(output, notice);
}
