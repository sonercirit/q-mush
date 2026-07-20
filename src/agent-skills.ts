import type { BraveSearchSkill } from "./brave-search.ts";
import type { JsonRecord } from "./oauth.ts";

const BRAVE_SEARCH_TOOL_NAME = "brave_search";

interface AgentSkillsOptions {
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly userId: string;
}

export interface AgentSkills {
  execute(name: string, arguments_: JsonRecord): Promise<string> | undefined;
}

export function createAgentSkills(options: AgentSkillsOptions): AgentSkills {
  return {
    execute: (name, arguments_) =>
      name === BRAVE_SEARCH_TOOL_NAME
        ? options.braveSearch.execute(options.userId, arguments_)
        : undefined,
  };
}
