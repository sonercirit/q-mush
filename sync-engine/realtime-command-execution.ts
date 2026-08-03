import {
  RealtimeCommandError,
  SESSION_REALTIME_OPERATIONS,
} from "../shared/user-realtime-protocol.ts";
import { utf8ByteLength } from "../shared/utf8.ts";

const EPHEMERAL_COMMAND_OPERATIONS = new Set<string>([
  SESSION_REALTIME_OPERATIONS.history,
  SESSION_REALTIME_OPERATIONS.models,
  SESSION_REALTIME_OPERATIONS.previewToolUpdate,
  SESSION_REALTIME_OPERATIONS.read,
  SESSION_REALTIME_OPERATIONS.subscribe,
]);

export function commandRequiresDurableReceipt(operation: string): boolean {
  return !EPHEMERAL_COMMAND_OPERATIONS.has(operation);
}

export type CommandResult =
  | { readonly result: unknown; readonly type: "command_success" }
  | {
      readonly detail?: string;
      readonly error: string;
      readonly type: "command_error";
    };

export interface CommandExecution {
  readonly replayResult: Promise<CommandResult>;
  readonly resolveCompletion: () => void;
  readonly result: Promise<CommandResult>;
}

function completedResult(result: unknown, maximumResultBytes: number): unknown {
  let serialized: string;
  try {
    const value = JSON.stringify(result);
    if (typeof value !== "string") {
      throw new RealtimeCommandError("command_failed");
    }
    serialized = value;
  } catch {
    throw new RealtimeCommandError("command_failed");
  }
  if (utf8ByteLength(serialized) > maximumResultBytes) {
    throw new RealtimeCommandError("command_result_too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new RealtimeCommandError("command_failed");
  }
  return parsed;
}

function safeError(
  error: unknown,
): Readonly<{ detail?: string; error: string }> {
  if (
    !(error instanceof RealtimeCommandError) ||
    !/^[a-z][a-z\d_]{0,99}$/u.test(error.code)
  ) {
    return { error: "command_failed" };
  }
  return {
    error: error.code,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
}

export function commandExecution(
  execute: () => unknown,
  maximumResultBytes: number,
): CommandExecution {
  let resolveCompletion = (): void => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const resultPromise: Promise<CommandResult> = Promise.resolve()
    .then(execute)
    .then((result) => completedResult(result, maximumResultBytes))
    .then(
      (result) => ({ result, type: "command_success" as const }),
      (error: unknown) => ({
        ...safeError(error),
        type: "command_error" as const,
      }),
    );
  return {
    replayResult: resultPromise.then(async (result) => {
      await completion;
      return result;
    }),
    resolveCompletion,
    result: resultPromise,
  };
}

export function resultBodyBytes(result: CommandResult): number {
  try {
    const body =
      result.type === "command_success"
        ? result.result
        : { detail: result.detail, error: result.error };
    const serialized = JSON.stringify(body);
    return typeof serialized === "string" ? utf8ByteLength(serialized) : 0;
  } catch {
    return 0;
  }
}
