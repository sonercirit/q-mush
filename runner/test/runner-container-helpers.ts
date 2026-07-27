import {
  RunnerContainerManager,
  type RunnerContainerRun,
} from "../runner-container.ts";
import type { RunnerProcessResult } from "../runner-process.ts";

export interface FakeContainerCall {
  readonly arguments: readonly string[];
  readonly executable: string;
  readonly timeoutSeconds: number | undefined;
}

export function processResult(
  overrides: Partial<RunnerProcessResult> = {},
): RunnerProcessResult {
  return {
    exitCode: 0,
    standardError: "",
    standardOutput: "",
    termination: undefined,
    ...overrides,
  };
}

export function containerRunResult(
  arguments_: readonly string[],
  output: string,
): Promise<RunnerProcessResult> | undefined {
  return arguments_[0] === "run"
    ? Promise.resolve(processResult({ standardOutput: `${output}\n` }))
    : undefined;
}

export function runResultHandler(output: string): ContainerOperationHandler {
  return (arguments_) =>
    containerRunResult(arguments_, output) ?? Promise.resolve(processResult());
}

export function finalRemoval(calls: readonly FakeContainerCall[]) {
  return calls.at(-1)?.arguments;
}

function pendingResult(
  assign: (release: (result: RunnerProcessResult) => void) => void,
): Promise<RunnerProcessResult> {
  return new Promise((resolve) => {
    assign(resolve);
  });
}

type ContainerRunOptions = Parameters<RunnerContainerRun>[2];
type ContainerOperationHandler = (
  arguments_: readonly string[],
  options: ContainerRunOptions,
) => Promise<RunnerProcessResult>;

function recordedRun(
  calls: FakeContainerCall[],
  execute: (
    arguments_: readonly string[],
    options: ContainerRunOptions,
  ) => Promise<RunnerProcessResult>,
): RunnerContainerRun {
  return (executable, arguments_, options) => {
    calls.push({
      arguments: arguments_,
      executable,
      timeoutSeconds: options.timeoutSeconds,
    });
    return execute(arguments_, options);
  };
}

export function containerOperationRun(
  calls: FakeContainerCall[],
  handlers: Readonly<
    Partial<Record<"exec" | "run", ContainerOperationHandler>>
  >,
): RunnerContainerRun {
  return recordedRun(calls, (arguments_, options) => {
    const operation = arguments_[0];
    const handler =
      operation === "exec" || operation === "run"
        ? handlers[operation]
        : undefined;
    return handler?.(arguments_, options) ?? Promise.resolve(processResult());
  });
}

function deferredProcessResult(): {
  readonly promise: Promise<RunnerProcessResult>;
  readonly resolve: (result: RunnerProcessResult) => void;
} {
  let release: ((result: RunnerProcessResult) => void) | undefined;
  const promise = pendingResult((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: (result) => release?.(result),
  };
}

export function recordingContainerRun(
  calls: FakeContainerCall[],
  execute: (arguments_: readonly string[]) => Promise<RunnerProcessResult>,
): RunnerContainerRun {
  return recordedRun(calls, execute);
}

export function removalCall(identifier: string): readonly string[] {
  return ["rm", "--force", identifier];
}

export function removalArguments(
  calls: readonly FakeContainerCall[],
): readonly string[][] {
  return calls
    .filter(({ arguments: arguments_ }) => arguments_[0] === "rm")
    .map(({ arguments: arguments_ }) => [...arguments_]);
}

export async function executeContainerShell(options: {
  readonly calls?: FakeContainerCall[];
  readonly command: string;
  readonly handlers: Readonly<
    Partial<Record<"exec" | "run", ContainerOperationHandler>>
  >;
  readonly onOutput?: Parameters<RunnerContainerManager["executeShell"]>[5];
  readonly timeoutSeconds: number;
  readonly workspace: string;
}): Promise<string> {
  const run = containerOperationRun(options.calls ?? [], options.handlers);
  const manager = new RunnerContainerManager({ run });
  return await executeFakeShell(
    manager,
    options.workspace,
    options.command,
    options.timeoutSeconds,
    options.onOutput,
  );
}

export function expectPreparationError(
  manager: RunnerContainerManager,
  workspace: string,
  message: string,
): Promise<void> {
  return expectManagerPreparation(manager, workspace).then(
    () => {
      throw new Error("Expected runner preparation to fail");
    },
    (error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes(message)) {
        throw error;
      }
    },
  );
}

async function executeFakeShell(
  manager: RunnerContainerManager,
  workspace: string,
  command: string,
  timeoutSeconds: number,
  onOutput?: Parameters<RunnerContainerManager["executeShell"]>[5],
): Promise<string> {
  return await manager.executeShell(
    "session-1",
    workspace,
    command,
    timeoutSeconds,
    undefined,
    onOutput,
  );
}

export function calledArguments(calls: readonly FakeContainerCall[]) {
  return calls.map(({ arguments: arguments_ }) => arguments_);
}

export function deferredContainerRun() {
  const calls: FakeContainerCall[] = [];
  const startup = deferredProcessResult();
  return {
    calls,
    run: containerOperationRun(calls, { run: () => startup.promise }),
    startup,
  };
}

function expectManagerPreparation(
  manager: RunnerContainerManager,
  workspace: string,
) {
  return manager.prepare("session-1", workspace);
}
