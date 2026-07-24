import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

function trackedChildProcessIds(parentId: number): readonly number[] {
  if (process.platform !== "linux") {
    return [];
  }
  const descendants = new Set<number>();
  const visit = (id: number): void => {
    let value: string;
    try {
      value = readFileSync(
        `/proc/${String(id)}/task/${String(id)}/children`,
        "utf8",
      );
    } catch {
      return;
    }
    for (const field of value.trim().split(/\s+/u)) {
      const childId = Number(field);
      if (
        Number.isSafeInteger(childId) &&
        childId > 0 &&
        !descendants.has(childId)
      ) {
        descendants.add(childId);
        visit(childId);
      }
    }
  };
  visit(parentId);
  return [...descendants];
}

function stopTrackedChildren(
  ids: readonly number[],
  signal: NodeJS.Signals,
): void {
  for (const id of ids) {
    try {
      process.kill(id, signal);
    } catch {
      // The tracked browser child has already stopped.
    }
  }
}

const PROFILE_REMOVAL_ERROR = "Could not remove the temporary Chromium profile";

async function removeProfileAttempts(
  path: string,
  attempts: number,
  afterRemoval?: () => Promise<void>,
  afterFailure?: () => void,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { force: true, recursive: true });
      await afterRemoval?.();
      return;
    } catch (error) {
      lastError = error;
      afterFailure?.();
      await Bun.sleep(50);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(PROFILE_REMOVAL_ERROR);
}

async function removeChromiumProfileWhileStopped(
  child: Bun.ReadableSubprocess,
  path: string,
): Promise<void> {
  await removeProfileAttempts(
    path,
    20,
    async () => {
      await Bun.sleep(10);
      await rm(path, { force: true, recursive: true });
    },
    () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    },
  );
}

export async function stopChromium(
  child: Bun.ReadableSubprocess,
  profilePath?: string,
): Promise<void> {
  const children = trackedChildProcessIds(child.pid);
  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  stopTrackedChildren(children, "SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (!exited) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    stopTrackedChildren(children, "SIGKILL");
    await child.exited;
  }
  if (profilePath !== undefined) {
    await removeChromiumProfileWhileStopped(child, profilePath);
  }
}

export async function removeChromiumProfile(path: string): Promise<void> {
  await removeProfileAttempts(path, 5);
}
