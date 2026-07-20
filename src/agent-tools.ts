const STRING_PARAMETER = { type: "string" } as const;

function toolDefinition<const Name extends string>(options: {
  readonly description: string;
  readonly name: Name;
  readonly properties: Readonly<Record<string, unknown>>;
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
    "Run multiple independent read, bash, edit, or write calls concurrently. Do not use this when one call depends on another call's result.",
  name: "parallel",
  properties: {
    tool_uses: {
      description: "Independent base-tool calls to run concurrently",
      items: {
        additionalProperties: false,
        properties: {
          parameters: {
            additionalProperties: true,
            description: "Arguments for the selected base tool",
            type: "object",
          },
          recipient_name: {
            description: "Base tool to call",
            enum: BASE_AGENT_TOOLS.map((tool) => tool.function.name),
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

export const AGENT_TOOLS = [...BASE_AGENT_TOOLS, PARALLEL_TOOL] as const;

export type AgentToolName = (typeof AGENT_TOOLS)[number]["function"]["name"];
export type BaseAgentToolName =
  (typeof BASE_AGENT_TOOLS)[number]["function"]["name"];

export function isAgentToolName(name: string): name is AgentToolName {
  return AGENT_TOOLS.some((tool) => tool.function.name === name);
}

export function isBaseAgentToolName(name: string): name is BaseAgentToolName {
  return BASE_AGENT_TOOLS.some((tool) => tool.function.name === name);
}
