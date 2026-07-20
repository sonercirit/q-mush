import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  isAgentToolName,
  isBaseAgentToolName,
  type BaseAgentToolName,
} from "./agent-tools.ts";
import { isRecord } from "./auth-model.ts";
import {
  resolveRunnerWorkspace,
  runnerPathIsWithin,
} from "./runner-workspace.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 50 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAXIMUM_EDITS = 100;
const MAXIMUM_PARALLEL_TOOLS = 8;
const MAX_PARALLEL_TOOL_OUTPUT_BYTES = 50 * 1_024;

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

function readOptionalInteger(
  arguments_: ToolArguments,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = arguments_[name];

  if (value === undefined) {
    return undefined;
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

function optionalInteger(
  arguments_: ToolArguments,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return readOptionalInteger(arguments_, name, minimum, maximum) ?? fallback;
}

function requiredInteger(
  arguments_: ToolArguments,
  name: string,
  minimum: number,
): number {
  const value = readOptionalInteger(arguments_, name, minimum);

  if (value === undefined) {
    throw new Error(`Tool argument ${name} must be an integer`);
  }

  return value;
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

async function readPathContent(
  root: string,
  arguments_: ToolArguments,
): Promise<{ readonly content: string; readonly path: string }> {
  const path = await pathArgument(root, arguments_);
  return { content: await readTextFile(path, MAX_FILE_BYTES), path };
}

function truncateReadLines(lines: readonly string[]): readonly string[] {
  const output: string[] = [];
  let bytes = 0;

  for (const line of lines.slice(0, MAX_READ_LINES)) {
    const lineBytes =
      Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);

    if (bytes + lineBytes > MAX_READ_OUTPUT_BYTES) {
      break;
    }

    output.push(line);
    bytes += lineBytes;
  }

  return output;
}

async function readTool(
  root: string,
  arguments_: ToolArguments,
): Promise<string> {
  const { content } = await readPathContent(root, arguments_);
  const offset = optionalInteger(arguments_, "offset", 1, 1, 1_000_000_000);
  const limit = optionalInteger(
    arguments_,
    "limit",
    MAX_READ_LINES,
    1,
    1_000_000_000,
  );
  const lines = content.split("\n");
  const start = offset - 1;

  if (start >= lines.length) {
    throw new Error(
      `Offset ${String(offset)} is beyond end of file (${String(lines.length)} lines total)`,
    );
  }

  const requested = lines.slice(start, start + limit);
  const shown = truncateReadLines(requested);

  if (shown.length === 0 && requested.length > 0) {
    return `[Line ${String(offset)} exceeds the ${String(MAX_READ_OUTPUT_BYTES / 1_024)}KB read limit. Use bash to read a bounded segment.]`;
  }

  const output = shown.join("\n");
  const nextOffset = start + shown.length + 1;
  return nextOffset <= lines.length
    ? `${output}\n\n[Showing lines ${String(offset)}-${String(nextOffset - 1)} of ${String(lines.length)}. Use offset=${String(nextOffset)} to continue.]`
    : output;
}

async function writeTool(
  root: string,
  arguments_: ToolArguments,
): Promise<string> {
  const content = requiredString(arguments_, "content", MAX_FILE_BYTES, true);
  const path = await pathArgument(root, arguments_, true);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return `Wrote ${String(Buffer.byteLength(content))} bytes to ${displayPath(root, path)}.`;
}

interface EditReplacement {
  readonly newText: string;
  readonly oldText: string;
}

interface LocatedEdit extends EditReplacement {
  readonly end: number;
  readonly start: number;
}

function editReplacements(
  arguments_: ToolArguments,
): readonly EditReplacement[] {
  const value = arguments_["edits"];

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAXIMUM_EDITS
  ) {
    throw new Error("Tool argument edits must contain valid replacements");
  }

  return value.map((replacement) => {
    if (!isRecord(replacement)) {
      throw new Error("Tool argument edits must contain valid replacements");
    }

    return {
      newText: requiredString(replacement, "newText", MAX_FILE_BYTES, true),
      oldText: requiredString(replacement, "oldText", MAX_FILE_BYTES),
    };
  });
}

function locateEdits(
  content: string,
  replacements: readonly EditReplacement[],
): readonly LocatedEdit[] {
  const located = replacements
    .map((replacement) => {
      const start = content.indexOf(replacement.oldText);

      if (start < 0) {
        throw new Error("The edit text was not found in the file");
      }

      if (content.includes(replacement.oldText, start + 1)) {
        throw new Error("The edit text occurs more than once in the file");
      }

      return {
        ...replacement,
        end: start + replacement.oldText.length,
        start,
      };
    })
    .sort((left, right) => left.start - right.start);

  for (let index = 1; index < located.length; index += 1) {
    const previous = located[index - 1];
    const current = located[index];

    if (
      previous !== undefined &&
      current !== undefined &&
      current.start < previous.end
    ) {
      throw new Error("The requested edits overlap");
    }
  }

  return located;
}

async function editTool(
  root: string,
  arguments_: ToolArguments,
): Promise<string> {
  const replacements = editReplacements(arguments_);
  const { content, path } = await readPathContent(root, arguments_);
  const edits = locateEdits(content, replacements);
  let updated = content;

  for (const edit of [...edits].reverse()) {
    updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
  }

  await writeFile(path, updated, "utf8");
  return `Successfully replaced ${String(edits.length)} block(s) in ${displayPath(root, path)}.`;
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

async function bashTool(
  root: string,
  arguments_: ToolArguments,
  signal: AbortSignal | undefined,
): Promise<string> {
  const command = requiredString(arguments_, "command", 32_768);
  const timeoutSeconds = requiredInteger(arguments_, "timeout", 1);
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

interface ParallelToolUse {
  readonly parameters: ToolArguments;
  readonly recipientName: BaseAgentToolName;
}

function parallelToolUses(
  arguments_: ToolArguments,
): readonly ParallelToolUse[] {
  const value = arguments_["tool_uses"];

  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > MAXIMUM_PARALLEL_TOOLS
  ) {
    throw new Error("Tool argument tool_uses must contain 2 to 8 calls");
  }

  return value.map((toolUse) => {
    if (!isRecord(toolUse) || !isRecord(toolUse["parameters"])) {
      throw new Error("Tool argument tool_uses contains an invalid call");
    }

    const recipientName = requiredString(toolUse, "recipient_name", 100);

    if (!isBaseAgentToolName(recipientName)) {
      throw new Error(`Unknown parallel recipient: ${recipientName}`);
    }

    return { parameters: toolUse["parameters"], recipientName };
  });
}

type RunnerTool = (
  root: string,
  arguments_: ToolArguments,
  signal?: AbortSignal,
) => Promise<string>;

const RUNNER_TOOLS: Readonly<Record<BaseAgentToolName, RunnerTool>> = {
  bash: bashTool,
  edit: editTool,
  read: readTool,
  write: writeTool,
};

function truncateParallelOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");

  if (bytes.byteLength <= MAX_PARALLEL_TOOL_OUTPUT_BYTES) {
    return output;
  }

  let end = MAX_PARALLEL_TOOL_OUTPUT_BYTES;

  while (end > 0 && (bytes[end] ?? 0) >> 6 === 2) {
    end -= 1;
  }

  return `${bytes.subarray(0, end).toString("utf8")}\n[parallel output truncated]`;
}

function parallelError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const parallelTool: RunnerTool = async (root, arguments_, signal) => {
  const results = await Promise.all(
    parallelToolUses(arguments_).map(async (toolUse) => {
      try {
        const output = await RUNNER_TOOLS[toolUse.recipientName](
          root,
          toolUse.parameters,
          signal,
        );
        return {
          output: truncateParallelOutput(output),
          recipient_name: toolUse.recipientName,
        };
      } catch (error) {
        if (signal?.aborted === true) {
          throw error;
        }

        return {
          error: parallelError(error),
          recipient_name: toolUse.recipientName,
        };
      }
    }),
  );
  return JSON.stringify(results, null, 2);
};

export async function executeRunnerTool(
  workingDirectory: string,
  name: string,
  arguments_: ToolArguments,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted === true) {
    throw new Error("The runner command was stopped");
  }

  if (!isAgentToolName(name)) {
    throw new Error(`Unknown runner tool: ${name}`);
  }

  const root = await resolveRunnerWorkspace(workingDirectory);
  return name === "parallel"
    ? parallelTool(root, arguments_, signal)
    : RUNNER_TOOLS[name](root, arguments_, signal);
}
