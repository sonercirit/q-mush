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
  const nextOffset = start + requested.length + 1;
  const output = requested.join("\n");
  return nextOffset <= lines.length
    ? `${output}\n\n[Showing lines ${String(offset)}-${String(nextOffset - 1)} of ${String(lines.length)}. Use offset=${String(nextOffset)} to continue.]`
    : limit >= lines.length && offset === 1
      ? content
      : output;
}
