import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  aggregateParallelToolResults,
  executeParallelResultCall,
  mapWithParallelConcurrency,
} from "../shared/parallel.ts";
import type { RunnerCommandResult } from "../shared/runner-command-broker.ts";

import { isAskQuestionsToolName } from "./ask-questions-pause.ts";
import type { BraveSearchExecutor } from "./brave-search.ts";
import type { JsonRecord } from "./oauth.ts";
import { completedRunnerCommandResult } from "./runner-command-result.ts";

const BRAVE_SEARCH_TOOL_NAME = "brave_search";
const PARALLEL_TOOL_NAME = "parallel";

type AgentSkillParameters = readonly [
  name: string,
  arguments_: JsonRecord,
  signal?: AbortSignal,
  callId?: string,
];
type AgentSkillArgumentParameters = Readonly<{
  readonly arguments_: JsonRecord;
  readonly callId: string | undefined;
  readonly signal: AbortSignal | undefined;
}>;
export type AgentSkillExecutor = (
  ...parameters: AgentSkillParameters
) => Promise<RunnerCommandResult | string>;

interface AgentSkillsOptions {
  readonly braveSearch:
    | BraveSearchExecutor
    | {
        execute(
          userId: string,
          arguments_: JsonRecord,
          signal?: AbortSignal,
        ): Promise<string>;
      };
  readonly currentTools?:
    (() => readonly AgentSessionToolName[] | undefined) | undefined;
  readonly executeTool: AgentSkillExecutor;
  readonly tools: readonly AgentSessionToolName[];
  readonly userId: string;
  readonly workspaceId?: string;
}

export interface AgentSkills {
  execute: (...parameters: AgentSkillParameters) => Promise<string> | undefined;
  executeResult: (
    ...parameters: AgentSkillParameters
  ) => Promise<RunnerCommandResult> | undefined;
}

interface ParallelSkillCall {
  readonly parameters: JsonRecord;
  readonly recipientName: string;
}

function parallelSkillCalls(
  arguments_: JsonRecord,
): readonly ParallelSkillCall[] | undefined {
  const toolUses = arguments_["tool_uses"];
  if (!Array.isArray(toolUses) || toolUses.length < 2) {
    return undefined;
  }

  const calls = toolUses.flatMap((toolUse): readonly ParallelSkillCall[] => {
    if (
      !isRecord(toolUse) ||
      typeof toolUse["recipient_name"] !== "string" ||
      !isRecord(toolUse["parameters"]) ||
      toolUse["recipient_name"] === PARALLEL_TOOL_NAME
    ) {
      return [];
    }
    return [
      {
        parameters: toolUse["parameters"],
        recipientName: toolUse["recipient_name"],
      },
    ];
  });
  return calls.length === toolUses.length ? calls : undefined;
}

function isConfiguredToolName(
  options: AgentSkillsOptions,
  name: string,
): name is AgentSessionToolName {
  return options.tools.some((tool) => tool === name);
}

function normalizedResult(
  result: RunnerCommandResult | string,
): RunnerCommandResult {
  return typeof result === "string"
    ? completedRunnerCommandResult(result)
    : result;
}

function executeBraveSearch(
  options: AgentSkillsOptions,
  arguments_: JsonRecord,
  signal?: AbortSignal,
): Promise<string> {
  const parameters =
    options.workspaceId === undefined
      ? [options.userId, arguments_, signal]
      : [options.userId, options.workspaceId, arguments_, signal];
  const result: unknown = Reflect.apply(
    options.braveSearch.execute,
    options.braveSearch,
    parameters,
  );
  return Promise.resolve(result).then((value) => {
    if (typeof value !== "string") {
      throw new Error("The Brave Search skill returned invalid output");
    }
    return value;
  });
}

function executeParallelSkills(
  options: AgentSkillsOptions,
  { arguments_, signal, callId }: AgentSkillArgumentParameters,
): Promise<RunnerCommandResult> | undefined {
  const calls = parallelSkillCalls(arguments_);
  if (calls === undefined) {
    return undefined;
  }

  return mapWithParallelConcurrency(
    calls,
    ({ parameters, recipientName }) =>
      executeParallelResultCall(
        recipientName,
        () =>
          !isConfiguredToolName(options, recipientName) ||
          options.currentTools?.()?.includes(recipientName) === false
            ? Promise.resolve(
                completedRunnerCommandResult(
                  `Error: ${recipientName} is not enabled for this session.`,
                ),
              )
            : isAskQuestionsToolName(recipientName)
              ? Promise.resolve(
                  completedRunnerCommandResult(
                    "Error: ask_questions cannot run inside parallel or another tool.",
                  ),
                )
              : recipientName === BRAVE_SEARCH_TOOL_NAME
                ? executeBraveSearch(options, parameters, signal).then(
                    completedRunnerCommandResult,
                  )
                : options
                    .executeTool(recipientName, parameters, signal, callId)
                    .then(normalizedResult),
        signal,
      ),
    signal,
  ).then(aggregateParallelToolResults);
}

function executeSkill(
  options: AgentSkillsOptions,
  name: string,
  arguments_: JsonRecord,
  signal?: AbortSignal,
  callId?: string,
): Promise<RunnerCommandResult> | undefined {
  return name === BRAVE_SEARCH_TOOL_NAME
    ? executeBraveSearch(options, arguments_, signal).then(
        completedRunnerCommandResult,
      )
    : name === PARALLEL_TOOL_NAME
      ? executeParallelSkills(options, { arguments_, callId, signal })
      : undefined;
}

export function createAgentSkills(options: AgentSkillsOptions): AgentSkills {
  return {
    execute: (...parameters) =>
      executeSkill(options, ...parameters)?.then(({ output }) => output),
    executeResult: (...parameters) => executeSkill(options, ...parameters),
  };
}
