import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import {
  boundedParallelOutput,
  executeParallelCall,
  mapWithParallelConcurrency,
} from "../shared/parallel.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { JsonRecord } from "./oauth.ts";

const BRAVE_SEARCH_TOOL_NAME = "brave_search";
const PARALLEL_TOOL_NAME = "parallel";

interface AgentSkillsOptions {
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly executeTool: (
    name: string,
    arguments_: JsonRecord,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly tools: readonly AgentSessionToolName[];
  readonly userId: string;
}

export interface AgentSkills {
  execute(
    name: string,
    arguments_: JsonRecord,
    signal?: AbortSignal,
  ): Promise<string> | undefined;
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

function executeParallelSkills(
  options: AgentSkillsOptions,
  arguments_: JsonRecord,
  signal?: AbortSignal,
): Promise<string> | undefined {
  const calls = parallelSkillCalls(arguments_);
  if (calls === undefined) {
    return undefined;
  }

  return mapWithParallelConcurrency(
    calls,
    ({ parameters, recipientName }) =>
      executeParallelCall(
        recipientName,
        () =>
          !options.tools.some((name) => name === recipientName)
            ? Promise.resolve(
                `Error: ${recipientName} is not enabled for this session.`,
              )
            : recipientName === "ask_questions"
              ? Promise.resolve(
                  "Error: ask_questions cannot run inside parallel.",
                )
              : recipientName === BRAVE_SEARCH_TOOL_NAME
                ? options.braveSearch.execute(
                    options.userId,
                    parameters,
                    signal,
                  )
                : options.executeTool(recipientName, parameters, signal),
        signal,
      ),
    signal,
  ).then(boundedParallelOutput);
}

export function createAgentSkills(options: AgentSkillsOptions): AgentSkills {
  return {
    execute: (name, arguments_, signal) =>
      name === BRAVE_SEARCH_TOOL_NAME
        ? options.braveSearch.execute(options.userId, arguments_, signal)
        : name === PARALLEL_TOOL_NAME
          ? executeParallelSkills(options, arguments_, signal)
          : undefined,
  };
}
