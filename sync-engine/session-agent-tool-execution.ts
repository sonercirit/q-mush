import type { AgentLoopOptions } from "../shared/agent-loop.ts";
import {
  isAgentSessionToolName,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type { RunnerCommandResult } from "../shared/runner-command-broker.ts";
import type { AgentSkillExecutor, AgentSkills } from "./agent-skills.ts";
import {
  isAskQuestionsPause,
  isAskQuestionsToolName,
  pauseForAskQuestions,
} from "./ask-questions-pause.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import { isRestartHandoffError } from "./session-restart-handoff-error.ts";
import { boundSessionToolOutput } from "./session-tool-output.ts";

const RESTART_INTERRUPTED_TOOL_OUTPUT =
  "Error: the runner disconnected before this tool call returned; retry it after restart.";

export type AgentToolDispatcher = (
  ...parameters: Parameters<AgentSkillExecutor>
) => Promise<RunnerCommandResult>;

function restartInterruptedToolResult(): RunnerCommandResult {
  return { output: RESTART_INTERRUPTED_TOOL_OUTPUT, state: "canceled" };
}

export function boundRuntimeToolOutput(
  runtime: SessionAgentRuntimeDependencies,
  signal: AbortSignal,
  result: RunnerCommandResult,
): Promise<RunnerCommandResult> {
  return boundSessionToolOutput(
    {
      broker: runtime.broker,
      detail: runtime.detail,
      isCurrent: runtime.isCurrent,
      signal,
    },
    result,
  );
}

export async function executeAgentTool(
  runtime: SessionAgentRuntimeDependencies,
  stepTools: ReadonlySet<AgentSessionToolName>,
  currentTools: () => ReadonlySet<AgentSessionToolName> | undefined,
  skills: AgentSkills,
  dispatchTool: AgentToolDispatcher,
  toolSignal: AbortSignal,
  call: Parameters<AgentLoopOptions["executeTool"]>[0],
): Promise<RunnerCommandResult> {
  if (isRestartHandoffError(toolSignal.reason)) {
    return restartInterruptedToolResult();
  }
  try {
    if (
      !isAgentSessionToolName(call.name) ||
      !stepTools.has(call.name) ||
      currentTools()?.has(call.name) !== true
    ) {
      return {
        output: `Error: ${call.name} is not enabled for this session.`,
        state: "failed",
      };
    }
    if (isAskQuestionsToolName(call.name)) {
      return {
        output: pauseForAskQuestions(
          {
            notify: (userId, sessionId) => {
              if (
                userId === runtime.userId &&
                sessionId === runtime.detail.id
              ) {
                runtime.notify();
              }
            },
            now: runtime.now,
            questions: runtime.store.questions(),
          },
          {
            arguments: call.arguments,
            executionGeneration: runtime.detail.generation,
            selected: stepTools.has("ask_questions"),
            sessionId: runtime.detail.id,
            source: "direct",
            toolCallId: call.id,
            userId: runtime.userId,
          },
        ),
        state: "completed",
      };
    }
    const skillOutput = skills.executeResult(
      call.name,
      call.arguments,
      toolSignal,
      call.id,
    );
    const result = await (skillOutput ??
      dispatchTool(call.name, call.arguments, toolSignal, call.id));
    return skillOutput === undefined
      ? result
      : await boundRuntimeToolOutput(runtime, toolSignal, result);
  } catch (error) {
    if (isAskQuestionsPause(error)) {
      throw error;
    }
    if (
      isRestartHandoffError(error) ||
      isRestartHandoffError(toolSignal.reason)
    ) {
      return restartInterruptedToolResult();
    }
    throw error;
  }
}
