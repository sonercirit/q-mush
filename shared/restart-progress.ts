export interface RestartProgressTool {
  readonly count: number;
  readonly name: string;
}

export interface RestartProgressEntry {
  readonly elapsedMs: number;
  readonly sessionId: string;
  readonly tools: readonly RestartProgressTool[];
  readonly totalTools: number;
}

function toolText({ count, name }: RestartProgressTool): string {
  return count === 1 ? name : `${name} ×${String(count)}`;
}

function restartProgressEntryText(
  { elapsedMs, sessionId, tools, totalTools }: RestartProgressEntry,
  separator = " ",
): string {
  const shown = tools.reduce((total, tool) => total + tool.count, 0);
  const overflow = Math.max(0, totalTools - shown);
  const pending =
    tools.length === 0
      ? "no active tool"
      : `${tools.map(toolText).join(", ")}${overflow === 0 ? "" : `, +${String(overflow)} more`}`;
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
