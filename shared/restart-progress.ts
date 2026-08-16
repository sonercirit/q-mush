export interface RestartProgressEntry {
  readonly elapsedMs: number;
  readonly sessionId: string;
  readonly tools: readonly string[];
}

function restartProgressEntryText(
  { elapsedMs, sessionId, tools }: RestartProgressEntry,
  separator = " ",
): string {
  const pending = tools.length === 0 ? "no active tool" : tools.join(", ");
  return `${sessionId}${separator}${pending} (${String(Math.round(elapsedMs / 1_000))}s)`;
}

export function restartProgressReport(
  progress: readonly RestartProgressEntry[],
  separator = " ",
): string {
  return progress
    .map((entry) => restartProgressEntryText(entry, separator))
    .join("; ");
}
