import type { RunnerCommandOutputDelta } from "../shared/runner-command-broker.ts";
import { DEFAULT_TOOL_OUTPUT_CHARACTERS } from "../shared/tool-limits.ts";
import {
  unicodeCharacterCount,
  unicodeCharacterPrefix,
} from "../shared/tool-output-limits.ts";
import {
  MAXIMUM_TOOL_STREAM_DELTA_BYTES,
  type RunnerCommandResult,
} from "../shared/tool-stream.ts";
import { utf8Prefix } from "../shared/utf8.ts";

type RunnerProcessTermination = "stopped" | "timed-out";

export interface RunnerProcessResult {
  readonly exitCode: number;
  readonly standardError: string;
  readonly standardOutput: string;
  readonly termination: RunnerProcessTermination | undefined;
}

export interface RunnerProcessOptions {
  readonly arguments: readonly string[];
  readonly cwd?: string;
  readonly executable: string;
  readonly onOutput?: (
    delta: Omit<RunnerCommandOutputDelta, "sequence">,
  ) => void;
  readonly outputLimitCharacters?: number;
  readonly signal?: AbortSignal;
  readonly timeoutSeconds?: number;
}

export function throwIfRunnerCommandStopped(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) {
    throw new Error("The runner command was stopped");
  }
}

const COMMAND_GROUP_WRAPPER = `
terminate_command_group() {
  trap - TERM
  kill -TERM 0
}
trap terminate_command_group TERM
"$@" &
command_pid=$!
wait "$command_pid"
exit $?
`;

interface RunnerProcessCaptureBudget {
  remainingCharacters: number;
}

function processCaptureBudget(
  outputLimitCharacters = DEFAULT_TOOL_OUTPUT_CHARACTERS,
): RunnerProcessCaptureBudget {
  // One extra code point lets the engine distinguish an exact boundary from
  // overflow before it adds the sole model-facing truncation notice.
  return { remainingCharacters: outputLimitCharacters + 1 };
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  channel: RunnerCommandOutputDelta["channel"],
  capture: RunnerProcessCaptureBudget,
  onOutput?: RunnerProcessOptions["onOutput"],
): Promise<string> {
  // Both process channels share one retained-memory budget. Live deltas stay
  // independently transport-bounded and do not consume model-facing output.
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const publish = (content: string): void => {
    let remaining = content;
    while (remaining.length > 0) {
      const chunk = utf8Prefix(remaining, MAXIMUM_TOOL_STREAM_DELTA_BYTES);
      if (chunk.length === 0) {
        return;
      }
      onOutput?.({ channel, content: chunk });
      remaining = remaining.slice(chunk.length);
    }
  };

  const retain = (content: string): boolean => {
    const available = capture.remainingCharacters;
    const contentCharacters = unicodeCharacterCount(content);
    const accepted = unicodeCharacterPrefix(content, available);
    output += accepted;
    const acceptedCharacters = unicodeCharacterCount(accepted);
    capture.remainingCharacters -= acceptedCharacters;
    return contentCharacters <= available;
  };

  for (;;) {
    const part = await reader.read();
    if (part.done) {
      const final = decoder.decode();
      retain(final);
      if (final.length > 0) publish(final);
      break;
    }
    const content = decoder.decode(part.value, { stream: true });
    publish(content);
    // Continue draining after retained capture overflows. Canceling a pipe can
    // leave a verbose child blocked on the other/full pipe and prevent exit.
    retain(content);
  }

  return output;
}

export async function runRunnerProcess(
  options: RunnerProcessOptions,
): Promise<RunnerProcessResult> {
  throwIfRunnerCommandStopped(options.signal);
  const state: {
    settled: boolean;
    termination: RunnerProcessTermination | undefined;
  } = { settled: false, termination: undefined };
  const child = Bun.spawn<"ignore", "pipe", "pipe">(
    [
      "/bin/sh",
      "-c",
      COMMAND_GROUP_WRAPPER,
      "q-mush-runner-command",
      options.executable,
      ...options.arguments,
    ],
    {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      detached: true,
      onExit: () => {
        state.settled = true;
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const terminate = (reason: RunnerProcessTermination): void => {
    if (state.settled || state.termination !== undefined) {
      return;
    }
    state.termination = reason;
    child.kill("SIGTERM");
  };
  const stop = (): void => {
    terminate("stopped");
  };
  const timer =
    options.timeoutSeconds === undefined
      ? undefined
      : setTimeout(() => {
          terminate("timed-out");
        }, options.timeoutSeconds * 1_000);
  options.signal?.addEventListener("abort", stop, { once: true });

  const capture = processCaptureBudget(options.outputLimitCharacters);
  try {
    const [exitCode, standardError, standardOutput] = await Promise.all([
      child.exited,
      readStream(child.stderr, "stderr", capture, options.onOutput),
      readStream(child.stdout, "stdout", capture, options.onOutput),
    ]);
    const result = {
      exitCode,
      standardError,
      standardOutput,
      termination: state.termination,
    };
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", stop);
  }
}

export function runnerCommandResultFromOutput(
  output: string,
): RunnerCommandResult {
  if (output.includes("Timed out after ")) {
    return { output, state: "timed-out" };
  }
  const exitCode = /(?:^|\n)Exit code: (\d+)$/u.exec(output)?.[1];
  return {
    output,
    state: exitCode === undefined || exitCode === "0" ? "completed" : "failed",
  };
}

export function formatRunnerProcessResult(
  result: RunnerProcessResult,
  timeoutSeconds: number,
): string {
  if (result.termination === "stopped") {
    throw new Error("The runner command was stopped");
  }

  return [
    result.standardOutput.length === 0
      ? undefined
      : `stdout:\n${result.standardOutput}`,
    result.standardError.length === 0
      ? undefined
      : `stderr:\n${result.standardError}`,
    result.termination === "timed-out"
      ? `Timed out after ${String(timeoutSeconds)} seconds.`
      : `Exit code: ${String(result.exitCode)}`,
  ]
    .filter((section) => section !== undefined)
    .join("\n");
}
