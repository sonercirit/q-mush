import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { RunnerCommandResult } from "../shared/runner-command-broker.ts";
import { aggregateToolStreamState } from "../shared/tool-stream.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { JsonRecord } from "./oauth.ts";

const BRAVE_SEARCH_TOOL_NAME = "brave_search";
const PARALLEL_TOOL_NAME = "parallel";

type AgentSkillExecutor = (
  name: string,
  arguments_: JsonRecord,
  signal?: AbortSignal,
  callId?: string,
) => Promise<RunnerCommandResult>;

interface AgentSkillsOptions {
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly executeTool: AgentSkillExecutor;
  readonly tools: readonly AgentSessionToolName[];
  readonly userId: string;
}

export interface AgentSkills {
  execute: (
    ...parameters: Parameters<AgentSkillExecutor>
  ) => ReturnType<AgentSkillExecutor> | undefined;
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
    if (!isRecord(toolUse)) {
      return [];
    }
    const parameters = toolUse["parameters"];
    if (!isRecord(parameters)) {
      return [];
    }
    const name = toolUse["recipient_name"];
    return typeof name === "string"
      ? [{ parameters, recipientName: name }]
      : [];
  });
  return calls.length === toolUses.length ? calls : undefined;
}

function terminalState(
  results: readonly RunnerCommandResult[],
): RunnerCommandResult["state"] {
  return aggregateToolStreamState(
    new Set(results.map(({ state: resultState }) => resultState)),
  );
}

function completed(output: string): RunnerCommandResult {
  return {
    output,
    state: output.startsWith("Error: ") ? "failed" : "completed",
  };
}

function executeParallelSkills(
  options: AgentSkillsOptions,
  arguments_: JsonRecord,
  signal?: AbortSignal,
  callId?: string,
): Promise<RunnerCommandResult> | undefined {
  const calls = parallelSkillCalls(arguments_);
  if (calls === undefined) {
    return undefined;
  }

  return Promise.all(
    calls.map(async ({ parameters, recipientName }) => {
      const result = await (!options.tools.some(
        (name) => name === recipientName,
      )
        ? completed(`Error: ${recipientName} is not enabled for this session.`)
        : recipientName === BRAVE_SEARCH_TOOL_NAME
          ? options.braveSearch
              .execute(options.userId, parameters)
              .then(completed)
          : options.executeTool(recipientName, parameters, signal, callId));
      return { result, recipientName };
    }),
  ).then((entries) => ({
    output: JSON.stringify(
      entries.map(({ result, recipientName }) => ({
        output: result.output,
        recipient_name: recipientName,
      })),
      null,
      2,
    ),
    state: terminalState(entries.map(({ result }) => result)),
  }));
}

export function createAgentSkills(options: AgentSkillsOptions): AgentSkills {
  return {
    execute: (name, arguments_, signal, callId) =>
      name === BRAVE_SEARCH_TOOL_NAME
        ? options.braveSearch
            .execute(options.userId, arguments_)
            .then(completed)
        : name === PARALLEL_TOOL_NAME
          ? executeParallelSkills(options, arguments_, signal, callId)
          : undefined,
  };
}
