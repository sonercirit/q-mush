import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  agentAttachmentMediaTypeFromName,
  MAXIMUM_AGENT_ATTACHMENT_BYTES,
} from "../shared/agent-attachments.ts";
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

import { MAXIMUM_TOOL_OUTPUT_LINES } from "../shared/tool-output-limits.ts";
import {
  createPageFetchRunnerTool,
  PAGE_FETCH_TOOL_NAME,
  type PageFetchRunnerTool,
} from "./page-fetch.ts";
import { attachmentPathFromReference } from "./runner-attachments.ts";
import {
  readContinuation,
  type RunnerOutputSpills,
} from "./runner-output-spills.ts";
import {
  formatRunnerProcessResult,
  runnerCommandResultFromOutput,
  runRunnerProcess,
} from "./runner-process.ts";
import {
  containedRunnerPath,
  openSecureRunnerPath,
  resolveRunnerPath,
  resolveRunnerWorkspace,
} from "./runner-workspace.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_READ_LINES = MAXIMUM_TOOL_OUTPUT_LINES;
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
  /** Container sessions confine host-side file tools to the workspace. */
  readonly containPaths?: boolean;
  readonly mapAbsolutePath?: (path: string) => string;
  readonly outputSpills?: RunnerOutputSpills;
  readonly pageFetch?: PageFetchRunnerTool;
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

function pathResolutionOptions(
  options: RunnerToolExecutionOptions | undefined,
): Pick<PathArgumentOptions, "containPaths" | "mapAbsolutePath"> {
  return {
    ...(options?.containPaths === true ? { containPaths: true } : {}),
    ...(options?.mapAbsolutePath === undefined
      ? {}
      : { mapAbsolutePath: options.mapAbsolutePath }),
  };
}

interface PathArgumentOptions {
  readonly allowedExternalPath?: (path: string) => boolean;
  readonly containPaths?: boolean;
  readonly mapAbsolutePath?: (path: string) => string;
  readonly mayNotExist?: boolean;
}

async function pathArgument(
  root: string,
  arguments_: ToolArguments,
  options: PathArgumentOptions = {},
): Promise<string> {
  const requested = requiredString(arguments_, "path", 4_096);
  const mapped = options.mapAbsolutePath?.(requested) ?? requested;
  const attachmentPath = await attachmentPathFromReference(root, mapped);
  if (attachmentPath !== undefined) {
    return attachmentPath;
  }
  if (options.containPaths !== true) {
    return resolveRunnerPath(root, mapped, options.mayNotExist);
  }
  if (options.allowedExternalPath?.(resolve(root, mapped)) === true) {
    const canonical = await realpath(mapped);
    if (options.allowedExternalPath(canonical)) {
      return canonical;
    }
  }
  return containedRunnerPath(root, mapped, options.mayNotExist);
}

function displayPath(root: string, path: string): string {
  const displayed = relative(root, path);
  if (displayed.length === 0) return ".";
  return displayed.startsWith("..") ? path : displayed;
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

function resolvedFileToolArguments(
  parameters: Parameters<RunnerFileTool>,
  mayNotExist = false,
): Promise<RunnerFileToolArguments & { readonly path: string }> {
  const context = runnerFileToolArguments(parameters);
  return pathArgument(context.root, context.arguments_, {
    ...pathResolutionOptions(context.options),
    mayNotExist,
  }).then((path) => ({ ...context, path }));
}

async function readTool(
  ...[root, arguments_, , options]: Parameters<RunnerFileTool>
): Promise<string> {
  const ownedSpillPath = (candidate: string): boolean =>
    options?.outputSpills?.ownsPath(candidate) === true;
  const path = await pathArgument(root, arguments_, {
    allowedExternalPath: ownedSpillPath,
    ...pathResolutionOptions(options),
  });
  const content = await readTextFile(
    path,
    ownedSpillPath(path) ? undefined : MAX_FILE_BYTES,
  );
  const offset = optionalInteger(arguments_, "offset", 1, 1, 1_000_000_000);
  const limit = optionalInteger(
    arguments_,
    "limit",
    DEFAULT_READ_LINES,
    1,
    1_000_000_000,
  );
  return readContinuation(content, offset, limit);
}

async function explainFileTool(
  ...parameters: Parameters<RunnerFileTool>
): Promise<string> {
  const { arguments_, options, path, root } =
    await resolvedFileToolArguments(parameters);
  const prompt = arguments_["prompt"];
  if (
    prompt !== undefined &&
    (typeof prompt !== "string" || prompt.length > 4_000)
  ) {
    throw new Error(
      "Tool argument prompt must be a string of at most 4000 characters",
    );
  }
  const { handle, stats } = await openSecureRunnerPath(
    root,
    path,
    {},
    options?.containPaths === true,
  );
  try {
    if (!stats.isFile()) {
      throw new Error("The requested path is not a file");
    }
    if (stats.size > MAXIMUM_AGENT_ATTACHMENT_BYTES) {
      throw new Error(
        `The requested file exceeds ${String(MAXIMUM_AGENT_ATTACHMENT_BYTES)} bytes`,
      );
    }
    const data = Buffer.allocUnsafe(MAXIMUM_AGENT_ATTACHMENT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < data.byteLength) {
      const result = await handle.read(
        data,
        bytesRead,
        data.byteLength - bytesRead,
        null,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAXIMUM_AGENT_ATTACHMENT_BYTES) {
      throw new Error(
        `The requested file exceeds ${String(MAXIMUM_AGENT_ATTACHMENT_BYTES)} bytes`,
      );
    }
    return JSON.stringify({
      data: data.subarray(0, bytesRead).toString("base64"),
      mediaType: agentAttachmentMediaTypeFromName(path),
      name: basename(path),
    });
  } finally {
    await handle.close();
  }
}

async function writeTool(
  ...parameters: Parameters<RunnerFileTool>
): Promise<string> {
  const context = await resolvedFileToolArguments(parameters, true);
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
  const context = await resolvedFileToolArguments(editParameters, false);
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
  explain_file: explainFileTool,
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
  const aggregate = aggregateParallelToolResults(results);
  return options?.outputSpills === undefined
    ? aggregate
    : {
        ...aggregate,
        output: JSON.stringify(
          results.map(({ canonical }) => canonical),
          null,
          2,
        ),
      };
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
  const pageFetch = resolved.options?.pageFetch;
  if (resolved.name === PAGE_FETCH_TOOL_NAME && pageFetch !== undefined) {
    return pageFetch(resolved.root, resolved.arguments_, resolved.signal);
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
  const spills = resolved.options?.outputSpills;
  if (resolved.name === "parallel") {
    const result = await parallelResultFromResolved(resolved);
    if (spills !== undefined) {
      return { ...result, output: await spills.apply(result.output) };
    }
    return result;
  }
  const output = await executeResolvedRunnerTool(resolved);
  const result =
    resolved.name === "bash"
      ? runnerCommandResultFromOutput(output)
      : { output, state: "completed" as const };
  return spills !== undefined &&
    resolved.name !== "read" &&
    resolved.name !== "explain_file"
    ? { ...result, output: await spills.apply(result.output) }
    : result;
}
