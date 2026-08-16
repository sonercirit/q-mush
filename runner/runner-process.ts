import type { RunnerCommandOutputDelta } from "../shared/runner-command-broker.ts";
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
  readonly signal?: AbortSignal;
  readonly timeoutSeconds?: number;
}

const MAXIMUM_OUTPUT_BYTES = 256 * 1_024;

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

async function readStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  channel: RunnerCommandOutputDelta["channel"],
  onOutput?: RunnerProcessOptions["onOutput"],
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let byteLength = 0;
  let truncated = false;
  const publish = (value: Uint8Array, final = false): void => {
    let content = decoder.decode(value, { stream: !final });
    while (content.length > 0) {
      const chunk = utf8Prefix(content, MAXIMUM_TOOL_STREAM_DELTA_BYTES);
      if (chunk.length === 0) {
        return;
      }
      onOutput?.({ channel, content: chunk });
      content = content.slice(chunk.length);
    }
  };

  for (;;) {
    const part = await reader.read();
    if (part.done) {
      publish(new Uint8Array(), true);
      break;
    }
    const remaining = maximumBytes - byteLength;
    if (part.value.byteLength > remaining) {
      const accepted = part.value.slice(0, Math.max(remaining, 0));
      chunks.push(accepted);
      publish(accepted, true);
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(part.value);
    publish(part.value);
    byteLength += part.value.byteLength;
  }

  const output = Buffer.concat(chunks).toString("utf8");
  return truncated ? `${output}\n[output truncated]` : output;
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

  try {
    const [exitCode, standardError, standardOutput] = await Promise.all([
      child.exited,
      readStream(
        child.stderr,
        MAXIMUM_OUTPUT_BYTES / 2,
        "stderr",
        options.onOutput,
      ),
      readStream(
        child.stdout,
        MAXIMUM_OUTPUT_BYTES / 2,
        "stdout",
        options.onOutput,
      ),
    ]);
    return {
      exitCode,
      standardError,
      standardOutput,
      termination: state.termination,
    };
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
