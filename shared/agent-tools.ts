const STRING_PARAMETER = { type: "string" } as const;
const BRAVE_SEARCH_TOOL_NAME = "brave_search";

function toolDefinition<
  const Name extends string,
  const Properties extends Readonly<Record<string, unknown>>,
>(options: {
  readonly description: string;
  readonly name: Name;
  readonly properties: Properties;
  readonly required: readonly string[];
}) {
  return {
    function: {
      description: options.description,
      name: options.name,
      parameters: {
        additionalProperties: false,
        properties: options.properties,
        required: options.required,
        type: "object",
      },
    },
    type: "function",
  } as const;
}

const EDIT_REPLACEMENT_PARAMETER = {
  additionalProperties: false,
  properties: {
    newText: {
      description: "Replacement text for this targeted edit.",
      type: "string",
    },
    oldText: {
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
      type: "string",
    },
  },
  required: ["oldText", "newText"],
  type: "object",
} as const;

const BASE_AGENT_TOOLS = [
  toolDefinition({
    description:
      "Read the contents of a UTF-8 text file in the workspace. Output is truncated to 2000 lines or 50KB, whichever is hit first. Use offset and limit for large files, continuing with offset when the full file is needed.",
    name: "read",
    properties: {
      limit: {
        description: "Maximum number of lines to read",
        type: "number",
      },
      offset: {
        description: "Line number to start reading from (1-indexed)",
        type: "number",
      },
      path: {
        description:
          "Path to the file to read, relative to the workspace or absolute within it",
        type: "string",
      },
    },
    required: ["path"],
  }),
  toolDefinition({
    description:
      "Execute a bash command in the workspace. Returns bounded stdout, stderr, and the exit status. A positive timeout in seconds is required.",
    name: "bash",
    properties: {
      command: {
        description: "Bash command to execute",
        type: "string",
      },
      timeout: {
        description:
          "Required positive timeout in seconds; no default or configured maximum is applied",
        minimum: 1,
        type: "number",
      },
    },
    required: ["command", "timeout"],
  }),
  toolDefinition({
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. Each edit is matched against the original file, not incrementally.",
    name: "edit",
    properties: {
      edits: {
        description:
          "One or more targeted replacements. Do not include overlapping or nested edits. Merge edits that affect the same or nearby text.",
        items: EDIT_REPLACEMENT_PARAMETER,
        minItems: 1,
        type: "array",
      },
      path: {
        description:
          "Path to the file to edit, relative to the workspace or absolute within it",
        type: "string",
      },
    },
    required: ["path", "edits"],
  }),
  toolDefinition({
    description:
      "Write content to a file in the workspace. Creates the file if it does not exist, overwrites it if it does, and creates parent directories.",
    name: "write",
    properties: {
      content: {
        description: "Content to write to the file",
        ...STRING_PARAMETER,
      },
      path: {
        description:
          "Path to the file to write, relative to the workspace or absolute within it",
        ...STRING_PARAMETER,
      },
    },
    required: ["path", "content"],
  }),
] as const;

const PARALLEL_TOOL = toolDefinition({
  description:
    "Run multiple independent tool or skill calls concurrently. Do not use this when one call depends on another call's result.",
  name: "parallel",
  properties: {
    tool_uses: {
      description: "Independent tool or skill calls to run concurrently",
      items: {
        additionalProperties: false,
        properties: {
          parameters: {
            additionalProperties: true,
            description: "Arguments for the selected tool or skill",
            type: "object",
          },
          recipient_name: {
            description: "Tool or skill to call",
            enum: [
              ...BASE_AGENT_TOOLS.map((tool) => tool.function.name),
              BRAVE_SEARCH_TOOL_NAME,
            ],
            type: "string",
          },
        },
        required: ["recipient_name", "parameters"],
        type: "object",
      },
      maxItems: 8,
      minItems: 2,
      type: "array",
    },
  },
  required: ["tool_uses"],
});

const BRAVE_SEARCH_TOOL = toolDefinition({
  description:
    "Search the public web with the signed-in user's saved Brave Search API keys. Use this for current documentation, facts, and sources. Returns JSON with the query and web results.",
  name: BRAVE_SEARCH_TOOL_NAME,
  properties: {
    count: {
      description: "Number of results to return (1-20; defaults to 10)",
      maximum: 20,
      minimum: 1,
      type: "number",
    },
    query: {
      description: "Search query",
      type: "string",
    },
  },
  required: ["query"],
});

export const AGENT_TOOLS = [
  ...BASE_AGENT_TOOLS,
  PARALLEL_TOOL,
  BRAVE_SEARCH_TOOL,
] as const;

export interface AgentToolDefinition {
  readonly function: {
    readonly description: string;
    readonly name: AgentSessionToolName;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
  readonly type: "function";
}
export type AgentSessionToolName =
  (typeof AGENT_TOOLS)[number]["function"]["name"];
type BaseAgentToolName = (typeof BASE_AGENT_TOOLS)[number]["function"]["name"];

export const AGENT_SESSION_TOOL_NAMES: readonly AgentSessionToolName[] =
  AGENT_TOOLS.map(({ function: definition }) => definition.name);

const AGENT_TOOL_LABELS: Readonly<Record<AgentSessionToolName, string>> = {
  bash: "Shell",
  brave_search: "Brave Search",
  edit: "Edit files",
  parallel: "Parallel calls",
  read: "Read files",
  write: "Write files",
};

export interface AgentSessionToolOption {
  readonly description: string;
  readonly kind: "skill" | "tool";
  readonly label: string;
  readonly name: AgentSessionToolName;
}

export const AGENT_SESSION_TOOL_OPTIONS: readonly AgentSessionToolOption[] =
  AGENT_TOOLS.map(({ function: definition }) => ({
    description: definition.description,
    kind: definition.name === BRAVE_SEARCH_TOOL_NAME ? "skill" : "tool",
    label: AGENT_TOOL_LABELS[definition.name],
    name: definition.name,
  }));

export function isAgentSessionToolName(
  value: unknown,
): value is AgentSessionToolName {
  return AGENT_SESSION_TOOL_NAMES.some((name) => name === value);
}

export function readAgentSessionToolNames(
  value: unknown,
): readonly AgentSessionToolName[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const selected: AgentSessionToolName[] = [];
  for (const name of value) {
    if (!isAgentSessionToolName(name) || selected.includes(name)) {
      return undefined;
    }
    selected.push(name);
  }
  return selected;
}

function selectedParallelTool(
  selectedTools: readonly AgentToolDefinition[],
): AgentToolDefinition {
  return {
    ...PARALLEL_TOOL,
    function: {
      ...PARALLEL_TOOL.function,
      parameters: {
        ...PARALLEL_TOOL.function.parameters,
        properties: {
          ...PARALLEL_TOOL.function.parameters.properties,
          tool_uses: {
            ...PARALLEL_TOOL.function.parameters.properties.tool_uses,
            items: {
              ...PARALLEL_TOOL.function.parameters.properties.tool_uses.items,
              properties: {
                ...PARALLEL_TOOL.function.parameters.properties.tool_uses.items
                  .properties,
                recipient_name: {
                  ...PARALLEL_TOOL.function.parameters.properties.tool_uses
                    .items.properties.recipient_name,
                  enum: selectedTools
                    .map(({ function: definition }) => definition.name)
                    .filter((name) => name !== PARALLEL_TOOL.function.name),
                },
              },
            },
          },
        },
      },
    },
  };
}

export function selectedAgentTools(
  names: readonly AgentSessionToolName[],
): readonly AgentToolDefinition[] {
  const isSelected = (name: AgentSessionToolName): boolean =>
    names.includes(name);
  const selectedTools = AGENT_TOOLS.filter(({ function: definition }) =>
    isSelected(definition.name),
  );
  return selectedTools.map((tool) =>
    tool.function.name === PARALLEL_TOOL.function.name
      ? selectedParallelTool(selectedTools)
      : tool,
  );
}

export { type BaseAgentToolName };

type RunnerAgentToolName =
  BaseAgentToolName | typeof PARALLEL_TOOL.function.name;

const RUNNER_AGENT_TOOL_NAMES: readonly RunnerAgentToolName[] = [
  ...BASE_AGENT_TOOLS.map((tool) => tool.function.name),
  PARALLEL_TOOL.function.name,
];

export function isRunnerAgentToolName(
  name: string,
): name is RunnerAgentToolName {
  return RUNNER_AGENT_TOOL_NAMES.some((toolName) => toolName === name);
}

export function isBaseAgentToolName(name: string): name is BaseAgentToolName {
  return BASE_AGENT_TOOLS.some((tool) => tool.function.name === name);
}
