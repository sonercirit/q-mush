import { dlopen } from "bun:ffi";
import { constants, type Stats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { expandRunnerHome } from "./runner-path.ts";

const READ_ONLY_NONBLOCKING_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DARWIN_F_GETPATH = 50;
const DARWIN_MAX_PATH_BYTES = 1_024;

function runnerPathIsWithin(root: string, candidate: string): boolean {
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

/** Contained resolution for session attachment records only. */
export async function containedRunnerPath(
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

export function resolveRunnerPath(
  root: string,
  path: string,
  mayNotExist?: boolean,
): Promise<string> {
  const candidate = resolve(root, path);
  return mayNotExist === true
    ? Promise.resolve(candidate)
    : realpath(candidate);
}

interface OpenRunnerPath {
  readonly handle: FileHandle;
  readonly stats: Stats;
}

function darwinOpenPath(handle: FileHandle): string {
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    fcntl: { args: ["i32", "i32", "ptr"], returns: "i32" },
  });
  const path = Buffer.alloc(DARWIN_MAX_PATH_BYTES);

  try {
    if (library.symbols.fcntl(handle.fd, DARWIN_F_GETPATH, path) === -1) {
      throw new Error("The opened path could not be validated");
    }
  } finally {
    library.close();
  }

  const terminator = path.indexOf(0);
  if (terminator === -1) {
    throw new Error("The opened path is too long to validate");
  }
  return path.toString("utf8", 0, terminator);
}

interface SecureRunnerOpenOptions {
  readonly darwinPathFromHandle?: (
    handle: FileHandle,
  ) => Promise<string> | string;
  readonly openPath?: typeof open;
  readonly platform?: NodeJS.Platform;
}

async function canonicalOpenPath(
  handle: FileHandle,
  options: SecureRunnerOpenOptions,
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    return realpath(`/proc/self/fd/${String(handle.fd)}`);
  }
  if (platform === "darwin") {
    // F_GETPATH resolves the already-open descriptor; no pathname is reopened.
    return (options.darwinPathFromHandle ?? darwinOpenPath)(handle);
  }
  throw new Error("Secure file opening is unavailable on this platform");
}

async function openValidatedRunnerPath(
  canonical: string,
  validate: (openedPath: string) => void,
  options: SecureRunnerOpenOptions,
): Promise<OpenRunnerPath> {
  const handle = await (options.openPath ?? open)(
    canonical,
    READ_ONLY_NONBLOCKING_FLAGS,
  );

  try {
    const details = await handle.stat();
    validate(await canonicalOpenPath(handle, options));
    return { handle, stats: details };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function secureCanonicalRunnerPath(
  resolveCanonical: () => Promise<string>,
  validate: (openedPath: string, canonical: string) => void,
  options: SecureRunnerOpenOptions,
): Promise<OpenRunnerPath> {
  return resolveCanonical().then((canonical) =>
    openValidatedRunnerPath(
      canonical,
      (openedPath) => {
        validate(openedPath, canonical);
      },
      options,
    ),
  );
}

function validateCanonicalRunnerPath(
  openedPath: string,
  canonical: string,
): void {
  if (openedPath !== canonical) {
    throw new Error("The opened path changed while it was being validated");
  }
}

export function openSecureRunnerPath(
  root: string,
  path: string,
  options: SecureRunnerOpenOptions = {},
  contained = false,
): Promise<OpenRunnerPath> {
  return secureCanonicalRunnerPath(
    contained
      ? () => containedRunnerPath(root, path)
      : () => realpath(resolve(root, path)),
    contained
      ? (openedPath) => {
          assertWithin(root, openedPath);
        }
      : validateCanonicalRunnerPath,
    options,
  );
}

export async function resolveRunnerWorkspace(path: string): Promise<string> {
  const root = await realpath(expandRunnerHome(path));
  const details = await stat(root);

  if (!details.isDirectory()) {
    throw new Error("The session workspace is not a directory");
  }

  return root;
}
