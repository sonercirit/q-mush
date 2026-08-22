import { rename } from "node:fs/promises";

export async function publishBrowserLifecycleReport(
  pathname: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${pathname}.${String(process.pid)}.tmp`;
  await Bun.write(temporaryPath, JSON.stringify(value));
  await rename(temporaryPath, pathname);
}
