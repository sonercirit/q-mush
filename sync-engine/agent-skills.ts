import {
  isSessionAgentToolName,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  aggregateParallelToolResults,
  executeParallelResultCall,
  mapWithParallelConcurrency,
} from "../shared/parallel.ts";
import type { RunnerCommandResult } from "../shared/tool-stream.ts";

import { isAskQuestionsToolName } from "./ask-questions-pause.ts";
import type { BraveSearchExecutor } from "./brave-search.ts";
import type { JsonRecord } from "./oauth.ts";
import { completedRunnerCommandResult } from "./runner-command-result.ts";

const BRAVE_SEARCH_TOOL_NAME = "brave_search";
const PARALLEL_TOOL_NAME = "parallel";
const SLEEP_TOOL_NAME = "sleep";

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
type AgentSkillExecutor = (
  ...parameters: AgentSkillParameters
) => Promise<RunnerCommandResult | string>;

interface AgentSkillsOptions {
  readonly braveSearch:
    | BraveSearchExecutor
    | {
        execute: (
          userId: string,
          arguments_: JsonRecord,
          signal?: AbortSignal,
        ) => Promise<string>;
      };
  readonly currentTools?:
    (() => readonly AgentSessionToolName[] | undefined) | undefined;
  readonly executeTool: AgentSkillExecutor;
  readonly trackTool?: (
    callId: string | undefined,
    name: string,
    runnerCommand: boolean,
  ) => () => void;
  readonly restartRequested?: () => boolean;
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
  readonly nestedId: string;
  readonly parameters: JsonRecord;
  readonly recipientName: string;
  readonly toolName: string;
}

function normalizedToolName(name: string): string {
  const prefix = "functions.";
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function parallelSkillCalls(
  arguments_: JsonRecord,
): readonly ParallelSkillCall[] | undefined {
  const toolUses = arguments_["tool_uses"];
  if (!Array.isArray(toolUses) || toolUses.length < 2) {
    return undefined;
  }

  const calls = toolUses.flatMap(
    (toolUse, index): readonly ParallelSkillCall[] => {
      if (!isRecord(toolUse)) {
        return [];
      }
      const recipientValue = toolUse["recipient_name"];
      const recipientName =
        typeof recipientValue === "string" ? recipientValue : undefined;
      const toolName =
        recipientName === undefined
          ? undefined
          : normalizedToolName(recipientName);
      if (
        recipientName === undefined ||
        toolName === undefined ||
        !isRecord(toolUse["parameters"]) ||
        toolName === PARALLEL_TOOL_NAME
      ) {
        return [];
      }
      return [
        {
          nestedId: String(index),
          parameters: toolUse["parameters"],
          recipientName,
          toolName,
        },
      ];
    },
  );
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
    ({ nestedId, parameters, recipientName, toolName }) =>
      executeParallelResultCall(
        recipientName,
        async () => {
          if (options.restartRequested?.() === true) {
            return {
              output:
                "Error: this parallel tool call was canceled because the server is restarting.",
              state: "canceled",
            };
          }
          const nestedCallId = `${callId ?? "parallel"}:${nestedId}`;
          const runnerCommand =
            toolName !== BRAVE_SEARCH_TOOL_NAME &&
            (!isConfiguredToolName(options, toolName) ||
              !isSessionAgentToolName(toolName));
          const finishTracking = options.trackTool?.(
            nestedCallId,
            toolName,
            runnerCommand,
          );
          try {
            return await (!isConfiguredToolName(options, toolName) ||
            options.currentTools?.()?.includes(toolName) === false
              ? Promise.resolve(
                  completedRunnerCommandResult(
                    `Error: ${recipientName} is not enabled for this session.`,
                  ),
                )
              : toolName === SLEEP_TOOL_NAME
                ? Promise.resolve(
                    completedRunnerCommandResult(
                      "Error: sleep cannot run inside parallel.",
                    ),
                  )
                : isAskQuestionsToolName(toolName)
                  ? Promise.resolve(
                      completedRunnerCommandResult(
                        "Error: ask_questions cannot run inside parallel or another tool.",
                      ),
                    )
                  : toolName === BRAVE_SEARCH_TOOL_NAME
                    ? executeBraveSearch(options, parameters, signal).then(
                        completedRunnerCommandResult,
                      )
                    : options
                        .executeTool(toolName, parameters, signal, nestedCallId)
                        .then(normalizedResult));
          } finally {
            finishTracking?.();
          }
        },
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
