import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  isBaseAgentToolName,
  isRunnerAgentToolName,
  type BaseAgentToolName,
} from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  aggregateParallelToolResults,
  boundedParallelOutput,
  executeParallelCall,
  executeParallelResultCall,
  mapWithParallelConcurrency,
} from "../shared/parallel.ts";
import type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "../shared/runner-command-broker.ts";

import {
  createPageFetchRunnerTool,
  PAGE_FETCH_TOOL_NAME,
} from "./page-fetch.ts";
import {
  formatRunnerProcessResult,
  runnerCommandResultFromOutput,
  runRunnerProcess,
} from "./runner-process.ts";
import type { RunnerReadBudget } from "./runner-read-budget.ts";
import {
  resolveRunnerWorkspace,
  runnerPathIsWithin,
} from "./runner-workspace.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_READ_LINES = 2_000;
const MAXIMUM_EDITS = 100;

type ToolArguments = Readonly<Record<string, unknown>>;

type RunnerToolStream = (
  delta: Omit<RunnerCommandOutputDelta, "sequence">,
) => void;

type RunnerShellExecutor = (
  root: string,
  command: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
  stream?: RunnerToolStream,
) => Promise<RunnerCommandResult | string>;

export interface RunnerToolExecutionOptions {
  readonly mapAbsolutePath?: (path: string) => string;
  readonly readBudget?: RunnerReadBudget;
  readonly shell?: RunnerShellExecutor;
  readonly stream?: RunnerToolStream;
}

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
  options: {
    readonly allowedExternalPath?: (path: string) => boolean;
    readonly mapAbsolutePath?: (path: string) => string;
    readonly mayNotExist?: boolean;
  } = {},
): Promise<string> {
  const requested = requiredString(arguments_, "path", 4_096);
  const mapped = options.mapAbsolutePath?.(requested) ?? requested;
  if (options.allowedExternalPath?.(resolve(root, mapped)) === true) {
    const canonical = await realpath(mapped);
    if (options.allowedExternalPath(canonical)) {
      return canonical;
    }
  }
  return securePath(root, mapped, options.mayNotExist);
}

function displayPath(root: string, path: string): string {
  const displayed = relative(root, path);
  return displayed.length === 0 ? "." : displayed;
}

async function readTextFile(
  path: string,
  maximumBytes?: number,
): Promise<string> {
  const details = await stat(path);

  if (!details.isFile()) {
    throw new Error("The requested path is not a file");
  }

  if (maximumBytes !== undefined && details.size > maximumBytes) {
    throw new Error(`The requested file exceeds ${String(maximumBytes)} bytes`);
  }

  return readFile(path, "utf8");
}

async function readPathContent(
  root: string,
  arguments_: ToolArguments,
  mapAbsolutePath?: (path: string) => string,
  ownedSpillPath?: (path: string) => boolean,
): Promise<{ readonly content: string; readonly path: string }> {
  const path = await pathArgument(root, arguments_, {
    ...(ownedSpillPath === undefined
      ? {}
      : { allowedExternalPath: ownedSpillPath }),
    ...(mapAbsolutePath === undefined ? {} : { mapAbsolutePath }),
  });
  const maximumBytes =
    ownedSpillPath?.(path) === true ? undefined : MAX_FILE_BYTES;
  return { content: await readTextFile(path, maximumBytes), path };
}

function readContinuation(
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
  const selected = lines.slice(start, start + limit);
  const requested = selected.join("\n");
  const nextOffset = start + selected.length + 1;
  return nextOffset <= lines.length
    ? `${requested}\n\n[Showing lines ${String(offset)}-${String(nextOffset - 1)} of ${String(lines.length)}. Use offset=${String(nextOffset)} to continue.]`
    : limit >= lines.length && offset === 1
      ? content
      : requested;
}

type RunnerFileTool = (
  root: string,
  arguments_: ToolArguments,
  signal?: AbortSignal,
  options?: RunnerToolExecutionOptions,
) => Promise<string>;

interface RunnerFileToolArguments {
  readonly arguments_: ToolArguments;
  readonly options: RunnerToolExecutionOptions | undefined;
  readonly root: string;
}

function runnerFileToolArguments(
  parameters: Parameters<RunnerFileTool>,
): RunnerFileToolArguments {
  const [root, arguments_, , options] = parameters;
  return { arguments_, options, root };
}

function writableFileToolArguments(
  parameters: Parameters<RunnerFileTool>,
  mayNotExist = false,
): Promise<RunnerFileToolArguments & { readonly path: string }> {
  const context = runnerFileToolArguments(parameters);
  return pathArgument(context.root, context.arguments_, {
    ...(context.options?.mapAbsolutePath === undefined
      ? {}
      : { mapAbsolutePath: context.options.mapAbsolutePath }),
    mayNotExist,
  }).then((path) => ({ ...context, path }));
}

async function readTool(
  ...parameters: Parameters<RunnerFileTool>
): Promise<string> {
  const { arguments_, options, root } = runnerFileToolArguments(parameters);
  const { content, path } = await readPathContent(
    root,
    arguments_,
    options?.mapAbsolutePath,
    (candidate) => options?.readBudget?.ownsPath(candidate) === true,
  );
  const offset = optionalInteger(arguments_, "offset", 1, 1, 1_000_000_000);
  const limit = optionalInteger(
    arguments_,
    "limit",
    DEFAULT_READ_LINES,
    1,
    1_000_000_000,
  );
  const output = readContinuation(content, offset, limit);
  if (options?.readBudget === undefined) {
    return output;
  }
  return options.readBudget.isSpillPath(path)
    ? output
    : options.readBudget.apply(output);
}

async function writeTool(
  ...parameters: Parameters<RunnerFileTool>
): Promise<string> {
  const context = await writableFileToolArguments(parameters, true);
  const content = requiredString(
    context.arguments_,
    "content",
    MAX_FILE_BYTES,
    true,
  );
  await mkdir(dirname(context.path), { recursive: true });
  await writeFile(context.path, content, "utf8");
  return `Wrote ${String(Buffer.byteLength(content))} bytes to ${displayPath(context.root, context.path)}.`;
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
  ...parameters: Parameters<RunnerFileTool>
): Promise<string> {
  const editParameters: Parameters<RunnerFileTool> = parameters;
  const context = await writableFileToolArguments(editParameters, false);
  const replacements = editReplacements(context.arguments_);
  const content = await readTextFile(context.path, MAX_FILE_BYTES);
  const edits = locateEdits(content, replacements);
  let updated = content;

  for (const edit of [...edits].reverse()) {
    updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
  }

  await writeFile(context.path, updated, "utf8");
  return `Successfully replaced ${String(edits.length)} block(s) in ${displayPath(context.root, context.path)}.`;
}

async function bashTool(
  root: string,
  arguments_: ToolArguments,
  signal: AbortSignal | undefined,
  options?: RunnerToolExecutionOptions,
): Promise<string> {
  const command = requiredString(arguments_, "command", 32_768);
  const timeoutSeconds = requiredInteger(arguments_, "timeout", 1);
  if (options?.shell !== undefined) {
    const result = await options.shell(
      root,
      command,
      timeoutSeconds,
      signal,
      options.stream,
    );
    return typeof result === "string" ? result : result.output;
  }
  const result = await runRunnerProcess({
    arguments: ["-lc", command],
    cwd: root,
    executable: "/bin/sh",
    ...(options?.stream === undefined ? {} : { onOutput: options.stream }),
    ...(signal === undefined ? {} : { signal }),
    timeoutSeconds,
  });
  return formatRunnerProcessResult(result, timeoutSeconds);
}

interface ParallelToolUse {
  readonly parameters: ToolArguments;
  readonly recipientName: BaseAgentToolName;
}

function parallelToolUses(
  arguments_: ToolArguments,
): readonly ParallelToolUse[] {
  const value = arguments_["tool_uses"];

  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("Tool argument tool_uses must contain at least 2 calls");
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

type RunnerTool = RunnerFileTool;

const PAGE_FETCH_RUNNER_TOOL = createPageFetchRunnerTool();

const RUNNER_TOOLS: Readonly<Record<BaseAgentToolName, RunnerTool>> = {
  bash: bashTool,
  edit: editTool,
  [PAGE_FETCH_TOOL_NAME]: PAGE_FETCH_RUNNER_TOOL,
  read: readTool,
  write: writeTool,
};

interface RunnerParallelExecutionOptions {
  readonly execute: (
    root: string,
    toolUse: {
      readonly parameters: ToolArguments;
      readonly recipientName: BaseAgentToolName;
    },
    signal?: AbortSignal,
  ) => Promise<string>;
}

type ParallelToolArguments = readonly [
  root: string,
  arguments_: ToolArguments,
  signal: AbortSignal | undefined,
  execution: RunnerParallelExecutionOptions | undefined,
  options: RunnerToolExecutionOptions | undefined,
];

interface ParallelToolContext {
  readonly arguments_: ToolArguments;
  readonly execution: RunnerParallelExecutionOptions | undefined;
  readonly options: RunnerToolExecutionOptions | undefined;
  readonly root: string;
  readonly signal: AbortSignal | undefined;
}

function parallelToolContext(
  parameters: ParallelToolArguments,
): ParallelToolContext {
  const [root, arguments_, signal, execution, options] = parameters;
  return { arguments_, execution, options, root, signal };
}

const parallelTool = async (
  ...parameters: ParallelToolArguments
): Promise<string> => {
  const context = parallelToolContext(parameters);
  const selectedExecution: RunnerParallelExecutionOptions =
    context.execution ?? {
      execute: (parallelRoot, toolUse, parallelSignal) =>
        RUNNER_TOOLS[toolUse.recipientName](
          parallelRoot,
          toolUse.parameters,
          parallelSignal,
          context.options,
        ),
    };
  const results = await mapWithParallelConcurrency(
    parallelToolUses(context.arguments_),
    (toolUse) =>
      executeParallelCall(
        toolUse.recipientName,
        () => selectedExecution.execute(context.root, toolUse, context.signal),
        context.signal,
      ),
    context.signal,
  );
  return boundedParallelOutput(results);
};

async function parallelToolResult(
  ...parameters: ParallelToolArguments
): Promise<RunnerCommandResult> {
  const { arguments_, execution, options, root, signal } =
    parallelToolContext(parameters);
  const results = await mapWithParallelConcurrency(
    parallelToolUses(arguments_),
    (toolUse) =>
      executeParallelResultCall(
        toolUse.recipientName,
        () =>
          execution === undefined
            ? executeRunnerToolResult(
                root,
                toolUse.recipientName,
                toolUse.parameters,
                signal,
                undefined,
                options,
              )
            : execution
                .execute(root, toolUse, signal)
                .then((output) => ({ output, state: "completed" })),
        signal,
      ),
    signal,
  );
  return aggregateParallelToolResults(results);
}

interface ResolvedRunnerTool {
  readonly arguments_: ToolArguments;
  readonly name: string;
  readonly options: RunnerToolExecutionOptions | undefined;
  readonly parallelExecution: RunnerParallelExecutionOptions | undefined;
  readonly root: string;
  readonly signal: AbortSignal | undefined;
}

function parallelArguments(
  resolved: ResolvedRunnerTool,
): ParallelToolArguments {
  return [
    resolved.root,
    resolved.arguments_,
    resolved.signal,
    resolved.parallelExecution,
    resolved.options,
  ];
}

function parallelResultFromResolved(
  resolved: ResolvedRunnerTool,
): Promise<RunnerCommandResult> {
  return parallelToolResult(...parallelArguments(resolved));
}

async function executeResolvedRunnerTool(
  resolved: ResolvedRunnerTool,
): Promise<string> {
  if (resolved.name === "parallel") {
    return parallelTool(...parallelArguments(resolved));
  }
  if (!isBaseAgentToolName(resolved.name)) {
    throw new Error(`Unknown runner tool: ${resolved.name}`);
  }
  return RUNNER_TOOLS[resolved.name](
    resolved.root,
    resolved.arguments_,
    resolved.signal,
    resolved.options,
  );
}

type ExecuteRunnerToolArguments = readonly [
  workingDirectory: string,
  name: string,
  arguments_: ToolArguments,
  signal?: AbortSignal,
  parallelExecution?: RunnerParallelExecutionOptions,
  options?: RunnerToolExecutionOptions,
];

async function resolvedRunnerTool(
  parameters: ExecuteRunnerToolArguments,
): Promise<ResolvedRunnerTool> {
  const [
    workingDirectory,
    name,
    arguments_,
    signal,
    parallelExecution,
    options,
  ] = parameters;
  if (!isRunnerAgentToolName(name)) {
    throw new Error(`Unknown runner tool: ${name}`);
  }
  return {
    arguments_,
    name,
    options,
    parallelExecution,
    root: await resolveRunnerWorkspace(workingDirectory),
    signal,
  };
}

/** @public Direct runner-tool helper retained for runner integrations. */
export async function executeRunnerTool(
  ...parameters: ExecuteRunnerToolArguments
): Promise<string> {
  const resolved = await resolvedRunnerTool(parameters);
  if (resolved.signal?.aborted === true) {
    throw new Error("The runner command was stopped");
  }
  return executeResolvedRunnerTool(resolved);
}

export async function executeRunnerToolResult(
  ...parameters: ExecuteRunnerToolArguments
): Promise<RunnerCommandResult> {
  const resolved = await resolvedRunnerTool(parameters);
  if (resolved.name === "parallel") {
    return parallelResultFromResolved(resolved);
  }
  const output = await executeResolvedRunnerTool(resolved);
  return resolved.name === "bash"
    ? runnerCommandResultFromOutput(output)
    : { output, state: "completed" };
}
