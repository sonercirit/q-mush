import {
  codePointPrefix,
  unicodeCharacterCount,
} from "../shared/tool-output-limits.ts";

function continuationMarker(
  offset: number,
  shownLines: number,
  totalLines: number,
): string {
  const nextOffset = offset + shownLines;
  return `\n\n[Showing lines ${String(offset)}-${String(nextOffset - 1)} of ${String(totalLines)}. Use offset=${String(nextOffset)} to continue.]`;
}

function boundedContinuationPage(
  requested: readonly string[],
  offset: number,
  maximum: number,
  totalLines: number,
): string {
  let pageCharacters = 0;
  let shownLines = 0;
  for (const line of requested) {
    const candidateLines = shownLines + 1;
    const candidateCharacters =
      pageCharacters + (shownLines === 0 ? 0 : 1) + unicodeCharacterCount(line);
    const marker = continuationMarker(offset, candidateLines, totalLines);
    if (candidateCharacters + unicodeCharacterCount(marker) > maximum) {
      break;
    }
    pageCharacters = candidateCharacters;
    shownLines = candidateLines;
  }
  if (shownLines === 0) {
    return codePointPrefix(requested[0] ?? "", maximum + 1);
  }
  return `${requested.slice(0, shownLines).join("\n")}${continuationMarker(
    offset,
    shownLines,
    totalLines,
  )}`;
}

export function readContinuation(
  content: string,
  offset: number,
  limit: number,
  maximumCharacters?: number,
): string {
  const lines = content.split("\n");
  const start = offset - 1;
  if (start >= lines.length) {
    throw new Error(
      `Offset ${String(offset)} is beyond end of file (${String(lines.length)} lines total)`,
    );
  }
  const requested = lines.slice(start, start + limit);
  const nextOffset = start + requested.length + 1;
  const output = requested.join("\n");
  const complete =
    nextOffset <= lines.length
      ? `${output}${continuationMarker(offset, requested.length, lines.length)}`
      : output;
  if (
    maximumCharacters === undefined ||
    unicodeCharacterCount(complete) <= maximumCharacters
  ) {
    return complete;
  }
  return boundedContinuationPage(
    requested,
    offset,
    maximumCharacters,
    lines.length,
  );
}
