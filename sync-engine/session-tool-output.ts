import { isAbsolute } from "node:path";
import {
  RUNNER_TOOL_OUTPUT_SPILL_COMMAND,
  RUNNER_TOOL_OUTPUT_SPILL_CONTENT_ARGUMENT,
  type RunnerCommandBroker,
  type RunnerCommandResult,
} from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  boundedToolOutput,
  formatBoundedToolOutput,
  hardTruncatedToolOutput,
  toolOutputLimitNotice,
} from "../shared/tool-output-limits.ts";

interface SessionToolOutputContext {
  readonly broker: RunnerCommandBroker;
  readonly detail: AgentSessionDetail;
  readonly isCurrent: () => boolean;
  readonly signal: AbortSignal;
}

export async function boundSessionToolOutput(
  context: SessionToolOutputContext,
  result: RunnerCommandResult,
): Promise<RunnerCommandResult> {
  const bounded = boundedToolOutput(result.output);
  if (!bounded.truncated) {
    return result;
  }
  try {
    const spill = await context.broker.dispatch(
      {
        arguments: {
          [RUNNER_TOOL_OUTPUT_SPILL_CONTENT_ARGUMENT]: result.output,
        },
        authorize: context.isCurrent,
        executionEnvironment: context.detail.executionEnvironment,
        generation: context.detail.generation,
        queueIfUnavailable: false,
        runnerId: context.detail.runnerId,
        sessionId: context.detail.id,
        tool: RUNNER_TOOL_OUTPUT_SPILL_COMMAND,
        workingDirectory: context.detail.workingDirectory,
      },
      context.signal,
    );
    if (
      spill.state !== "completed" ||
      !isAbsolute(spill.output) ||
      spill.output.includes("\0")
    ) {
      throw new Error("The runner could not save the tool output");
    }
    return {
      ...result,
      output: formatBoundedToolOutput(
        bounded,
        toolOutputLimitNotice(spill.output),
      ),
    };
  } catch {
    return { ...result, output: hardTruncatedToolOutput(result.output) };
  }
}
