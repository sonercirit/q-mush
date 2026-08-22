import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";
import type { AgentSkills } from "./agent-skills.ts";
import { pauseForAskQuestions } from "./ask-questions-pause.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import { executeToolWithinTimeLimit } from "./session-tool-time-limit.ts";

interface RuntimeToolExecution {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly name: string;
}

interface ToolExecutionOptions {
  readonly call: RuntimeToolExecution;
  readonly dispatch: AgentSkillDispatcher;
  readonly executeSkill: AgentSkills["executeResult"];
  readonly outerSignal: AbortSignal;
  readonly settings: ToolSettings;
}

type AgentSkillDispatcher = (
  name: string,
  input: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  callId?: string,
) => Promise<RunnerCommandResult>;

export type AgentToolDispatcher = AgentSkillDispatcher;

function askQuestionsResult(
  runtime: SessionAgentRuntimeDependencies,
  stepTools: ReadonlySet<AgentSessionToolName>,
  call: RuntimeToolExecution,
): RunnerCommandResult | undefined {
  if (call.name !== "ask_questions") return undefined;
  const sessionId = runtime.detail.id;
  return {
    output: pauseForAskQuestions(
      {
        notify: (userId, notifiedSessionId) => {
          if (userId === runtime.userId && notifiedSessionId === sessionId) {
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
        sessionId,
        source: "direct",
        toolCallId: call.id,
        userId: runtime.userId,
      },
    ),
    state: "completed",
  };
}

/** Applies the global deadline after authority checks. */
export function executeAuthorizedRuntimeTool(
  options: ToolExecutionOptions & {
    readonly runtime: SessionAgentRuntimeDependencies;
    readonly stepTools: ReadonlySet<AgentSessionToolName>;
  },
): Promise<RunnerCommandResult> {
  const questionResult = askQuestionsResult(
    options.runtime,
    options.stepTools,
    options.call,
  );
  return questionResult === undefined
    ? executeRuntimeTool(options)
    : Promise.resolve(questionResult);
}

function executeRuntimeTool(
  options: ToolExecutionOptions,
): Promise<RunnerCommandResult> {
  return executeToolWithinTimeLimit(
    async (signal) => {
      const { call } = options;
      const skillOutput = options.executeSkill(
        call.name,
        call.arguments,
        signal,
        call.id,
      );
      const result = await (skillOutput ??
        options.dispatch(call.name, call.arguments, signal, call.id));
      return result;
    },
    options.outerSignal,
    options.settings,
  );
}
