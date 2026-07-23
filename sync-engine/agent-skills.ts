import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
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
  if (!Array.isArray(toolUses) || toolUses.length < 2 || toolUses.length > 8) {
    return undefined;
  }

  const calls = toolUses.flatMap((toolUse): readonly ParallelSkillCall[] => {
    if (
      !isRecord(toolUse) ||
      typeof toolUse["recipient_name"] !== "string" ||
      !isRecord(toolUse["parameters"])
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

  return Promise.all(
    calls.map(async ({ parameters, recipientName }) => ({
      output: await (!options.tools.some((name) => name === recipientName)
        ? `Error: ${recipientName} is not enabled for this session.`
        : recipientName === BRAVE_SEARCH_TOOL_NAME
          ? options.braveSearch.execute(options.userId, parameters)
          : options.executeTool(recipientName, parameters, signal)),
      recipient_name: recipientName,
    })),
  ).then((results) => JSON.stringify(results, null, 2));
}

export function createAgentSkills(options: AgentSkillsOptions): AgentSkills {
  return {
    execute: (name, arguments_, signal) =>
      name === BRAVE_SEARCH_TOOL_NAME
        ? options.braveSearch.execute(options.userId, arguments_)
        : name === PARALLEL_TOOL_NAME
          ? executeParallelSkills(options, arguments_, signal)
          : undefined,
  };
}
