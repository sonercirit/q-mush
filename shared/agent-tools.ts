import { EDIT_REPLACEMENT_PARAMETER } from "./agent-edit-tool-schema.ts";
import { AGENT_TOOL_LABELS } from "./agent-tool-labels.ts";
import {
  ASK_QUESTIONS_TOOL_DEFINITION,
  ASK_QUESTIONS_TOOL_NAME,
} from "./ask-questions-tool.ts";
import { PAGE_FETCH_TOOL_DEFINITION } from "./page-fetch.ts";
import { MODEL_PROVIDER_IDS } from "./provider-id.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  toolExecutionLimitSeconds,
} from "./tool-limits.ts";

const NUMBER_PARAMETER = { type: "number" } as const;
const STRING_PARAMETER = { type: "string" } as const;
const WHOLE_SECONDS = {
  maximum: toolExecutionLimitSeconds(DEFAULT_TOOL_SETTINGS),
  minimum: 1,
  type: "integer",
} as const;
const BOOLEAN_PARAMETER = { type: "boolean" } as const;
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

const FILE_PATH_PARAMETER = {
  description: "Absolute file path, or a path relative to the workspace",
  type: "string",
} as const;

const BASE_AGENT_TOOLS = [
  toolDefinition({
    description:
      "Read UTF-8 text from a file, including q-mush-attachment links supplied in messages. Omit limit to read as many complete lines as fit the Unicode output budget; set limit for explicit positional pagination. Use offset to continue.",
    name: "read",
    properties: {
      limit: {
        description: "Explicit maximum number of lines to read",
        type: "number",
      },
      offset: {
        description: "Line number to start reading from (1-indexed)",
        type: "number",
      },
      path: FILE_PATH_PARAMETER,
    },
    required: ["path"],
  }),
  toolDefinition({
    description:
      "Read a file and ask the session model, or its configured global modality fallback, to explain its content. An optional per-call prompt controls what to explain.",
    name: "explain_file",
    properties: {
      path: FILE_PATH_PARAMETER,
      prompt: {
        description: "Optional instructions for this explanation",
        maxLength: 4_000,
        type: "string",
      },
    },
    required: ["path"],
  }),
  toolDefinition({
    description:
      "Execute a bash command from the workspace directory. Returns stdout, stderr, and the exit status.",
    name: "bash",
    properties: {
      command: {
        description: "Bash command to execute",
        type: "string",
      },
      timeout: {
        ...WHOLE_SECONDS,
        description: "Required timeout in seconds",
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
          "Absolute path to the file to edit, or a path relative to the workspace",
        type: "string",
      },
    },
    required: ["path", "edits"],
  }),
  toolDefinition({
    description:
      "Write content to a file. Creates the file if it does not exist, overwrites it if it does, and creates parent directories.",
    name: "write",
    properties: {
      content: {
        description: "Content to write to the file",
        ...STRING_PARAMETER,
      },
      path: {
        description:
          "Absolute path to the file to write, or a path relative to the workspace",
        ...STRING_PARAMETER,
      },
    },
    required: ["path", "content"],
  }),
] as const;

const BASE_AGENT_TOOL_NAMES = BASE_AGENT_TOOLS.map(
  (tool) => tool.function.name,
);

const SESSION_ID_PARAMETER = {
  sessionId: {
    description: "Owned session ID",
    ...STRING_PARAMETER,
  },
} as const;

const SESSION_AGENT_TOOLS = [
  toolDefinition({
    description:
      "Pause this session for a positive bounded duration in seconds. Pending steering wakes it early; the result reports actual and expected duration.",
    name: "sleep",
    properties: {
      durationSeconds: {
        ...WHOLE_SECONDS,
        description: "Duration to sleep in seconds",
      },
    },
    required: ["durationSeconds"],
  }),
  toolDefinition({
    description:
      "Spawn another agent session and return immediately. Configure it with the same fields as the new-session pane, including any working directory and agent-file path (relative or absolute; container sessions keep agent files inside the workspace). When it finishes or fails, its last message is sent back to this session.",
    name: "spawn_session",
    properties: {
      agentFilePath: {
        description: "Optional agent-file path, relative or absolute",
        ...STRING_PARAMETER,
      },
      autoCompact: {
        description: "Automatically compact near the context limit",
        ...BOOLEAN_PARAMETER,
      },
      idleCompact: {
        description: "Compact after 30 minutes idle (default false)",
        ...BOOLEAN_PARAMETER,
      },
      credentialId: {
        description: 'Credential ID or "balanced:<provider>" sentinel',
        ...STRING_PARAMETER,
      },
      executionEnvironment: {
        description: "Execution environment for file and shell tools",
        enum: ["bare_metal", "container"],
        type: "string",
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
        enum: MODEL_PROVIDER_IDS,
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
      "executionEnvironment",
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
      "Browse directories on an owned online runner. Use the returned canonical path as workingDirectory for reassign_session; start at ~ and navigate explicitly.",
    name: "browse_runner_directories",
    properties: {
      path: {
        description: "Directory to browse, such as ~ or a returned child path",
        ...STRING_PARAMETER,
      },
      runnerId: {
        description: "Owned online runner ID from list_runners",
        ...STRING_PARAMETER,
      },
    },
    required: ["runnerId", "path"],
  }),
  toolDefinition({
    description: "List only your currently online runners.",
    name: "list_runners",
    properties: {},
    required: [],
  }),
  toolDefinition({
    description:
      "List sessions with pagination (page defaults to 1; pageSize defaults to 20, max 26). Search spans title, status, model, provider, and working directory.",
    name: "list_sessions",
    properties: {
      page: {
        minimum: 1,
        type: "integer",
      },
      pageSize: {
        maximum: 26,
        minimum: 1,
        type: "integer",
      },
      search: {
        maxLength: 100,
        ...STRING_PARAMETER,
      },
    },
    required: [],
  }),
  toolDefinition({
    description:
      'Discover paginated spawn_session options. Credential results include "balanced:<provider>" for providers with at least two scoped accounts. Model lookups require provider and credentialId. No secrets or runner tokens are returned.',
    name: "get_session_options",
    properties: {
      category: {
        description: "Option category",
        enum: [
          "runners",
          "credentials",
          "models",
          "reasoning_efforts",
          "tools",
        ],
        type: "string",
      },
      credentialId: {
        description: "Owned model credential ID; required only for models",
        ...STRING_PARAMETER,
      },
      page: {
        description: "1-indexed result page (defaults to 1)",
        minimum: 1,
        ...NUMBER_PARAMETER,
      },
      provider: {
        description:
          "Model provider; required only for models and must match credentialId",
        ...STRING_PARAMETER,
      },
      search: {
        description:
          "Optional case-insensitive search applied before pagination",
        ...STRING_PARAMETER,
      },
    },
    required: ["category"],
  }),
  toolDefinition({
    description:
      "Read bounded sections of an owned session. Defaults to the last 20 user/assistant records. Select thinking for reasoning, tool for results, error for failure and truncation notices, tools for definitions, and assistant for content plus tool calls.",
    name: "read_session",
    properties: {
      ...SESSION_ID_PARAMETER,
      categories: {
        description: "Nonempty selection of the listed transcript categories",
        items: {
          enum: [
            "system",
            "user",
            "assistant",
            "thinking",
            "tool",
            "error",
            "tools",
          ],
          type: "string",
        },
        minItems: 1,
        type: "array",
        uniqueItems: true,
      },
      limit: {
        description:
          "Last matching transcript records (defaults to 20, maximum 100)",
        maximum: 100,
        minimum: 1,
        ...NUMBER_PARAMETER,
      },
    },
    required: ["sessionId"],
  }),
  toolDefinition({
    description:
      "Reassign an owned session whose runner was removed. First use list_runners, then supply an explicit working directory confirmed on that runner. This does not start the session.",
    name: "reassign_session",
    properties: {
      ...SESSION_ID_PARAMETER,
      runnerId: {
        description: "ID of an owned online replacement runner",
        ...STRING_PARAMETER,
      },
      workingDirectory: {
        description:
          "Explicit working directory selected or confirmed on the replacement runner",
        ...STRING_PARAMETER,
      },
    },
    required: ["sessionId", "runnerId", "workingDirectory"],
  }),
  toolDefinition({
    description: "Send a message to another owned idle or terminal session.",
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
    description: "Continue an owned idle or terminal session.",
    name: "continue_session",
    properties: SESSION_ID_PARAMETER,
    required: ["sessionId"],
  }),
  toolDefinition({
    description:
      "Schedule compaction for this session or another owned session. It runs at the target's current or next safe step boundary and always continues afterward; this call returns immediately when scheduled.",
    name: "compact_session",
    properties: SESSION_ID_PARAMETER,
    required: ["sessionId"],
  }),
  toolDefinition({
    description:
      "Steer a running owned session. The message is consumed at its next safe step boundary. For a non-running session, use send_to_session instead.",
    name: "steer_session",
    properties: {
      message: {
        description:
          "Steering instruction to deliver at the next step boundary",
        ...STRING_PARAMETER,
      },
      ...SESSION_ID_PARAMETER,
    },
    required: ["sessionId", "message"],
  }),
  toolDefinition({
    description: "Stop an owned session. By default, includes descendants.",
    name: "stop_session",
    properties: {
      cascade: { description: "Also stop descendants", ...BOOLEAN_PARAMETER },
      ...SESSION_ID_PARAMETER,
    },
    required: ["sessionId"],
  }),
] as const;

export const PARALLEL_TOOL = toolDefinition({
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
              ...BASE_AGENT_TOOL_NAMES,
              BRAVE_SEARCH_TOOL_NAME,
              ...SESSION_AGENT_TOOLS.map((tool) => tool.function.name).filter(
                (name) => name !== "sleep",
              ),
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
  PAGE_FETCH_TOOL_DEFINITION,
  ...BASE_AGENT_TOOLS,
  PARALLEL_TOOL,
  BRAVE_SEARCH_TOOL,
  { function: ASK_QUESTIONS_TOOL_DEFINITION, type: "function" },
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
type BaseAgentToolName =
  | (typeof BASE_AGENT_TOOLS)[number]["function"]["name"]
  | typeof PAGE_FETCH_TOOL_DEFINITION.function.name;

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

type AgentToolClassification = "runner_tool" | "session_tool" | "skill";

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
  return name === BRAVE_SEARCH_TOOL_NAME || name === ASK_QUESTIONS_TOOL_NAME
    ? "skill"
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

export { type BaseAgentToolName };

export type RunnerAgentToolName =
  | BaseAgentToolName
  | typeof PAGE_FETCH_TOOL_DEFINITION.function.name
  | typeof PARALLEL_TOOL.function.name;

const RUNNER_AGENT_TOOL_NAMES: readonly RunnerAgentToolName[] = [
  ...BASE_AGENT_TOOL_NAMES,
  PAGE_FETCH_TOOL_DEFINITION.function.name,
  PARALLEL_TOOL.function.name,
];

export function isRunnerAgentToolName(
  name: string,
): name is RunnerAgentToolName {
  return RUNNER_AGENT_TOOL_NAMES.some((toolName) => toolName === name);
}

export function isBaseAgentToolName(name: string): name is BaseAgentToolName {
  return (
    name === PAGE_FETCH_TOOL_DEFINITION.function.name ||
    BASE_AGENT_TOOLS.some((tool) => tool.function.name === name)
  );
}
