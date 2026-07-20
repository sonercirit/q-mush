import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 1_000;
const MAX_LIST_ENTRIES = 1_000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;
const MAX_COMMAND_TIMEOUT_SECONDS = 300;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

type ToolArguments = Readonly<Record<string, unknown>>;

function requiredString(
  arguments_: ToolArguments,
  name: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  const value = arguments_[name];

  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength
  ) {
    throw new Error(`Tool argument ${name} must be a valid string`);
  }

  return value;
}

function optionalInteger(
  arguments_: ToolArguments,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = arguments_[name];

  if (value === undefined) {
    return fallback;
  }

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Tool argument ${name} must be an integer`);
  }

  return value;
}

function expandsHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  return path.startsWith(`~${sep}`) ? resolve(homedir(), path.slice(2)) : path;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function assertWithin(root: string, candidate: string): void {
  if (!isWithin(root, candidate)) {
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

async function workspaceRoot(path: string): Promise<string> {
  const root = await realpath(expandsHome(path));
  const details = await stat(root);

  if (!details.isDirectory()) {
    throw new Error("The session workspace is not a directory");
  }

  return root;
}

async function securePath(
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

function optionalPathArgument(arguments_: ToolArguments): string {
  return arguments_["path"] === undefined
    ? "."
    : requiredString(arguments_, "path", 4_096);
}

async function pathArgument(
  root: string,
  arguments_: ToolArguments,
  mayNotExist = false,
): Promise<string> {
  return securePath(
    root,
    requiredString(arguments_, "path", 4_096),
    mayNotExist,
  );
}

function displayPath(root: string, path: string): string {
  const displayed = relative(root, path);
  return displayed.length === 0 ? "." : displayed;
}

async function readTextFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const details = await stat(path);

  if (!details.isFile()) {
    throw new Error("The requested path is not a file");
  }

  if (details.size > maximumBytes) {
    throw new Error(`The requested file exceeds ${String(maximumBytes)} bytes`);
  }

  return readFile(path, "utf8");
}

async function readFileTool(
  root: string,
  arguments_: ToolArguments,
): Promise<string> {
  const path = await pathArgument(root, arguments_);
  const content = await readTextFile(path, MAX_READ_BYTES);
  const offset = optionalInteger(arguments_, "offset", 1, 1, 1_000_000_000);
  const limit = optionalInteger(arguments_, "limit", 2_000, 1, 2_000);

  if (offset === 1 && limit === 2_000) {
    return content;
  }

  const lines = content.split("\n");
  return lines.slice(offset - 1, offset - 1 + limit).join("\n");
}

async function writeFileTool(
  root: string,
  arguments_: ToolArguments,
): Promise<string> {
  const content = requiredString(arguments_, "content", MAX_FILE_BYTES, true);
  const path = await pathArgument(root, arguments_, true);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return `Wrote ${String(Buffer.byteLength(content))} bytes to ${displayPath(root, path)}.`;
}

async function editFileTool(
  root: string,
  arguments_: ToolArguments,
): Promise<string> {
  const oldText = requiredString(arguments_, "oldText", MAX_FILE_BYTES);
  const newText = requiredString(arguments_, "newText", MAX_FILE_BYTES, true);
  const path = await pathArgument(root, arguments_);
  const content = await readTextFile(path, MAX_FILE_BYTES);
  const firstIndex = content.indexOf(oldText);

  if (firstIndex < 0) {
    throw new Error("The edit text was not found in the file");
  }

  if (content.includes(oldText, firstIndex + oldText.length)) {
    throw new Error("The edit text occurs more than once in the file");
  }

  const updated = `${content.slice(0, firstIndex)}${newText}${content.slice(firstIndex + oldText.length)}`;
  await writeFile(path, updated, "utf8");
  return `Updated ${displayPath(root, path)}.`;
}

interface WalkEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "link";
}

async function walk(
  start: string,
  maximumEntries: number,
): Promise<readonly WalkEntry[]> {
  const entries: WalkEntry[] = [];
  const pending = [start];

  while (pending.length > 0 && entries.length < maximumEntries) {
    const directory = pending.shift();

    if (directory === undefined) {
      break;
    }

    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      if (entries.length >= maximumEntries) {
        break;
      }

      const path = resolve(directory, child.name);

      if (child.isDirectory()) {
        entries.push({ path, type: "directory" });

        if (!SKIPPED_DIRECTORIES.has(child.name)) {
          pending.push(path);
        }
      } else if (child.isFile()) {
        entries.push({ path, type: "file" });
      } else if (child.isSymbolicLink()) {
        entries.push({ path, type: "link" });
      }
    }
  }

  return entries;
}

const listFilesTool = async (
  root: string,
  arguments_: ToolArguments,
): Promise<string> => {
  const path = await securePath(root, optionalPathArgument(arguments_));
  const details = await stat(path);

  if (!details.isDirectory()) {
    return displayPath(root, path);
  }

  const entries = await walk(path, MAX_LIST_ENTRIES);
  return entries
    .map(
      (entry) =>
        `${displayPath(root, entry.path)}${entry.type === "directory" ? "/" : entry.type === "link" ? "@" : ""}`,
    )
    .join("\n");
};

async function searchFilesTool(
  root: string,
  arguments_: ToolArguments,
): Promise<string> {
  const query = requiredString(arguments_, "query", 1_000);
  const start = await securePath(root, optionalPathArgument(arguments_));
  const details = await stat(start);
  const candidates = details.isFile()
    ? [{ path: start, type: "file" as const }]
    : await walk(start, MAX_SEARCH_FILES);
  const matches: string[] = [];

  for (const candidate of candidates) {
    if (candidate.type !== "file" || matches.length >= 500) {
      continue;
    }

    let content: string;

    try {
      content = await readTextFile(candidate.path, MAX_READ_BYTES);
    } catch {
      continue;
    }

    const lines = content.split("\n");

    for (const [index, line] of lines.entries()) {
      if (line.includes(query)) {
        matches.push(
          `${displayPath(root, candidate.path)}:${String(index + 1)}:${line}`,
        );

        if (matches.length >= 500) {
          break;
        }
      }
    }
  }

  return matches.length === 0 ? "No matches found." : matches.join("\n");
}

async function readLimitedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;

  for (;;) {
    const part = await reader.read();

    if (part.done) {
      break;
    }

    const remaining = maximumBytes - byteLength;

    if (part.value.byteLength > remaining) {
      chunks.push(part.value.slice(0, Math.max(remaining, 0)));
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(part.value);
    byteLength += part.value.byteLength;
  }

  const output = Buffer.concat(chunks).toString("utf8");
  return truncated ? `${output}\n[output truncated]` : output;
}

async function runCommandTool(
  root: string,
  arguments_: ToolArguments,
  signal: AbortSignal | undefined,
): Promise<string> {
  const command = requiredString(arguments_, "command", 32_768);
  const timeoutSeconds = optionalInteger(
    arguments_,
    "timeoutSeconds",
    DEFAULT_COMMAND_TIMEOUT_SECONDS,
    1,
    MAX_COMMAND_TIMEOUT_SECONDS,
  );
  const child = Bun.spawn(["/bin/sh", "-lc", command], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  const state = { stopped: false, timedOut: false };
  const stop = () => {
    state.stopped = true;
    child.kill();
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    child.kill();
  }, timeoutSeconds * 1_000);
  signal?.addEventListener("abort", stop, { once: true });

  if (signal?.aborted === true) {
    stop();
  }

  try {
    const [exitCode, standardError, standardOutput] = await Promise.all([
      child.exited,
      readLimitedStream(child.stderr, MAX_COMMAND_OUTPUT_BYTES / 2),
      readLimitedStream(child.stdout, MAX_COMMAND_OUTPUT_BYTES / 2),
    ]);
    if (state.stopped) {
      throw new Error("The runner command was stopped");
    }

    const sections = [
      standardOutput.length === 0 ? undefined : `stdout:\n${standardOutput}`,
      standardError.length === 0 ? undefined : `stderr:\n${standardError}`,
      state.timedOut
        ? `Timed out after ${String(timeoutSeconds)} seconds.`
        : `Exit code: ${String(exitCode)}`,
    ].filter((section) => section !== undefined);
    return sections.join("\n");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

export async function executeRunnerTool(
  workingDirectory: string,
  name: string,
  arguments_: ToolArguments,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted === true) {
    throw new Error("The runner command was stopped");
  }

  const root = await workspaceRoot(workingDirectory);

  switch (name) {
    case "edit_file":
      return editFileTool(root, arguments_);
    case "list_files":
      return listFilesTool(root, arguments_);
    case "read_file":
      return readFileTool(root, arguments_);
    case "run_command":
      return runCommandTool(root, arguments_, signal);
    case "search_files":
      return searchFilesTool(root, arguments_);
    case "write_file":
      return writeFileTool(root, arguments_);
    default:
      throw new Error(`Unknown runner tool: ${name}`);
  }
}
