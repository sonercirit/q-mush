import type { RestartProgressTool } from "./restart-progress.ts";

export function countRestartProgressTools(
  names: Iterable<string>,
): readonly RestartProgressTool[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ count, name }));
}
