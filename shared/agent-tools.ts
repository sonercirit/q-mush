const STRING_PARAMETER = { type: "string" } as const;
const STRING_ARRAY_PARAMETER = {
  items: STRING_PARAMETER,
  type: "array",
} as const;
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

const ASK_QUESTION_OPTION_PARAMETER = {
  /* jscpd:ignore-start */
  additionalProperties: false,
  properties: {
    label: {
      description: "Human-readable choice label",
      type: "string",
    },
    value: {
      description: "Stable value returned for this choice",
      type: "string",
    },
  },
  required: ["label", "value"],
  type: "object",
} as const;

const ASK_QUESTION_PARAMETER = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        id: STRING_PARAMETER,
        maxLength: {
          maximum: 4000,
          minimum: 1,
          type: "integer",
        },
        minLength: {
          maximum: 4000,
          minimum: 0,
          type: "integer",
        },
        prompt: STRING_PARAMETER,
        type: { const: "free_text", type: "string" },
      },
      required: ["id", "prompt", "type", "maxLength"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        id: STRING_PARAMETER,
        options: {
          items: ASK_QUESTION_OPTION_PARAMETER,
          maxItems: 12,
          minItems: 2,
          type: "array",
        },
        prompt: STRING_PARAMETER,
        type: { const: "single_choice", type: "string" },
      },
      required: ["id", "prompt", "type", "options"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        id: STRING_PARAMETER,
        maxSelections: {
          maximum: 12,
          minimum: 1,
          type: "integer",
        },
        minSelections: {
          maximum: 12,
          minimum: 0,
          type: "integer",
        },
        options: {
          items: ASK_QUESTION_OPTION_PARAMETER,
          maxItems: 12,
          minItems: 2,
          type: "array",
        },
        prompt: STRING_PARAMETER,
        type: { const: "multi_choice", type: "string" },
      },
      required: ["id", "prompt", "type", "options"],
      type: "object",
    },
  ],
} as const;

const ASK_QUESTIONS_TOOL = toolDefinition({
  description:
    "Ask the user one to eight bounded free-text, single-choice, or multi-choice questions. The session pauses until the authenticated user answers. Do not call this through parallel because it blocks for interactive input.",
  name: "ask_questions",
  properties: {
    questions: {
      description: "Questions to present together",
      items: ASK_QUESTION_PARAMETER,
      maxItems: 8,
      minItems: 1,
      type: "array",
    },
  },
  required: ["questions"],
});
/* jscpd:ignore-end */

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

const SESSION_ID_PARAMETER = {
  sessionId: {
    description: "Owned session ID",
    ...STRING_PARAMETER,
  },
} as const;

const SESSION_AGENT_TOOLS = [
  toolDefinition({
    description:
      "Spawn another agent session and return immediately. Configure it with the same fields available in the new-session pane. When it finishes or fails, its last message is sent back to this session.",
    name: "spawn_session",
    properties: {
      credentialId: {
        description: "Model credential ID",
        ...STRING_PARAMETER,
      },
      model: {
        description: "Provider model ID",
        ...STRING_PARAMETER,
      },
      prompt: {
        description: "Task for the spawned session",
        ...STRING_PARAMETER,
      },
      provider: {
        description: "Model provider",
        enum: ["openai", "openrouter"],
        type: "string",
      },
      reasoningEffort: {
        description: "Optional model reasoning effort",
        enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        type: "string",
      },
      runnerId: {
        description: "Runner ID",
        ...STRING_PARAMETER,
      },
      tools: {
        description: "Tools and skills enabled for the spawned session",
        ...STRING_ARRAY_PARAMETER,
      },
      workingDirectory: {
        description: "Working directory on the selected runner",
        ...STRING_PARAMETER,
      },
    },
    required: [
      "credentialId",
      "model",
      "prompt",
      "provider",
      "runnerId",
      "tools",
      "workingDirectory",
    ],
  }),
  toolDefinition({
    description:
      "List your agent sessions, including their IDs, titles, statuses, and configurations.",
    name: "list_sessions",
    properties: {},
    required: [],
  }),
  toolDefinition({
    description: "Read an owned agent session and its transcript by ID.",
    name: "read_session",
    properties: SESSION_ID_PARAMETER,
    required: ["sessionId"],
  }),
  toolDefinition({
    description:
      "Send a user message to another idle, failed, or stopped owned session and start it.",
    name: "send_to_session",
    properties: {
      ...SESSION_ID_PARAMETER,
      message: {
        description: "Instruction to send",
        ...STRING_PARAMETER,
      },
    },
    required: ["sessionId", "message"],
  }),
  toolDefinition({
    description:
      "Continue another idle, failed, or stopped owned session without adding a message.",
    name: "continue_session",
    properties: SESSION_ID_PARAMETER,
    required: ["sessionId"],
  }),
  toolDefinition({
    description: "Stop an owned agent session.",
    name: "stop_session",
    properties: SESSION_ID_PARAMETER,
    required: ["sessionId"],
  }),
] as const;

const PARALLEL_TOOL = toolDefinition({
  description:
    "Run multiple independent tool or skill calls with bounded concurrency. The number of accepted calls has no application-defined maximum, but only a small worker pool runs simultaneously. Do not use this when one call depends on another call's result.",
  name: "parallel",
  properties: {
    tool_uses: {
      description:
        "Independent tool or skill calls to run with bounded concurrency; all accepted calls run and results preserve input order",
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
              ...SESSION_AGENT_TOOLS.map((tool) => tool.function.name),
            ],
            type: "string",
          },
        },
        required: ["recipient_name", "parameters"],
        type: "object",
      },
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
  ASK_QUESTIONS_TOOL,
  ...SESSION_AGENT_TOOLS,
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

export const SESSION_AGENT_TOOL_NAMES: readonly AgentSessionToolName[] =
  SESSION_AGENT_TOOLS.map(({ function: definition }) => definition.name);

export type SessionAgentToolName =
  (typeof SESSION_AGENT_TOOLS)[number]["function"]["name"];

export function isSessionAgentToolName(
  value: AgentSessionToolName,
): value is SessionAgentToolName {
  return SESSION_AGENT_TOOL_NAMES.some((name) => name === value);
}

export const AGENT_SESSION_TOOL_NAMES: readonly AgentSessionToolName[] =
  AGENT_TOOLS.map(({ function: definition }) => definition.name);

const AGENT_TOOL_LABELS: Readonly<Record<AgentSessionToolName, string>> = {
  ask_questions: "Ask questions",
  bash: "Shell",
  brave_search: "Brave Search",
  continue_session: "Continue session",
  edit: "Edit files",
  list_sessions: "List sessions",
  parallel: "Parallel calls",
  read: "Read files",
  read_session: "Read session",
  send_to_session: "Send to session",
  spawn_session: "Spawn session",
  stop_session: "Stop session",
  write: "Write files",
};

type AgentToolClassification =
  "interactive_tool" | "runner_tool" | "session_tool" | "skill";

export interface AgentSessionToolOption {
  readonly classification: AgentToolClassification;
  readonly definition: AgentToolDefinition["function"];
  readonly description: string;
  readonly label: string;
  readonly name: AgentSessionToolName;
}

function agentToolClassification(
  name: AgentSessionToolName,
): AgentToolClassification {
  return name === BRAVE_SEARCH_TOOL_NAME
    ? "skill"
    : name === ASK_QUESTIONS_TOOL.function.name
      ? "interactive_tool"
      : SESSION_AGENT_TOOL_NAMES.some((sessionName) => sessionName === name)
        ? "session_tool"
        : "runner_tool";
}

export const AGENT_SESSION_TOOL_OPTIONS: readonly AgentSessionToolOption[] =
  AGENT_TOOLS.map(({ function: definition }) => ({
    classification: agentToolClassification(definition.name),
    definition,
    description: definition.description,
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
                    .filter(
                      (name) =>
                        name !== PARALLEL_TOOL.function.name &&
                        name !== ASK_QUESTIONS_TOOL.function.name,
                    ),
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
