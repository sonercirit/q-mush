import { constants, type Stats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { expandRunnerHome } from "./runner-path.ts";

const READ_ONLY_NONBLOCKING_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function runnerPathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function assertWithin(root: string, candidate: string): void {
  if (!runnerPathIsWithin(root, candidate)) {
    throw new Error("The requested path is outside the session workspace");
  }
}

async function existingAncestor(path: string): Promise<string> {
  let candidate = path;

  for (;;) {
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(candidate);

      if (parent === candidate) {
        throw new Error("The requested path has no accessible parent");
      }

      candidate = parent;
    }
  }
}

export async function secureRunnerPath(
  root: string,
  path: string,
  mayNotExist = false,
): Promise<string> {
  const candidate = resolve(root, path);
  assertWithin(root, candidate);

  if (mayNotExist) {
    assertWithin(root, await existingAncestor(candidate));
    return candidate;
  }

  const canonical = await realpath(candidate);
  assertWithin(root, canonical);
  return canonical;
}

interface OpenRunnerPath {
  readonly handle: FileHandle;
  readonly stats: Stats;
}

async function canonicalOpenPath(
  path: string,
  handle: FileHandle,
  details: Stats,
): Promise<string> {
  if (process.platform === "linux") {
    return realpath(`/proc/self/fd/${String(handle.fd)}`);
  }

  const canonical = await realpath(path);
  const comparisonHandle = await open(canonical, READ_ONLY_NONBLOCKING_FLAGS);
  try {
    const currentDetails = await comparisonHandle.stat();
    if (
      currentDetails.dev !== details.dev ||
      currentDetails.ino !== details.ino
    ) {
      throw new Error("The requested path changed while it was being opened");
    }
  } finally {
    await comparisonHandle.close();
  }
  return canonical;
}

export async function openSecureRunnerPath(
  root: string,
  path: string,
): Promise<OpenRunnerPath> {
  const canonical = await secureRunnerPath(root, path);
  const handle = await open(canonical, READ_ONLY_NONBLOCKING_FLAGS);

  try {
    const details = await handle.stat();
    assertWithin(root, await canonicalOpenPath(canonical, handle, details));
    return { handle, stats: details };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function resolveRunnerWorkspace(path: string): Promise<string> {
  const root = await realpath(expandRunnerHome(path));
  const details = await stat(root);

  if (!details.isDirectory()) {
    throw new Error("The session workspace is not a directory");
  }

  return root;
}
