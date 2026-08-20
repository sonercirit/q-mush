import { expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { selectedAgentTools } from "../agent-tool-selection.ts";
import {
  AGENT_SESSION_TOOL_OPTIONS,
  AGENT_TOOLS,
  isBaseAgentToolName,
  SESSION_AGENT_TOOL_NAMES,
} from "../agent-tools.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  toolExecutionLimitSeconds,
} from "../tool-limits.ts";

const DEFAULT_EXECUTION_LIMIT_SECONDS = toolExecutionLimitSeconds(
  DEFAULT_TOOL_SETTINGS,
);

function expectParallelRecipients(
  tools: ReturnType<typeof selectedAgentTools>,
  recipients: readonly string[],
): void {
  expect(
    tools.find(({ function: definition }) => definition.name === "parallel"),
  ).toMatchObject({
    function: {
      parameters: {
        properties: {
          tool_uses: {
            items: {
              properties: {
                recipient_name: { enum: recipients },
              },
            },
          },
        },
      },
    },
  });
}

test("lets parallel call every eligible tool and skill by default", () => {
  expectParallelRecipients(AGENT_TOOLS, [
    "read",
    "explain_file",
    "bash",
    "edit",
    "write",
    "brave_search",
    ...SESSION_AGENT_TOOL_NAMES.filter((name) => name !== "sleep"),
  ]);
});

test("keeps per-tool descriptions free of the shared global limits", () => {
  const read = AGENT_TOOLS.find(
    ({ function: definition }) => definition.name === "read",
  );

  // The read description keeps its per-call paging semantics but the
  // authoritative limit statement lives in the shared tool-limits module.
  expect(read?.function.description).not.toContain("50KB");
  expect(read?.function.description).not.toContain("2,000");
  expect(read?.function.description).toContain("offset");
});

test("bounds the bash timeout by the global execution limit", () => {
  const bash = AGENT_TOOLS.find((tool) => tool.function.name === "bash");

  if (bash?.function.name !== "bash") {
    throw new Error("The bash tool definition is unavailable");
  }
  expect(bash.function.parameters.properties.timeout).toMatchObject({
    maximum: DEFAULT_EXECUTION_LIMIT_SECONDS,
    minimum: 1,
    type: "integer",
  });
});

test("defines the sleep duration in bounded whole seconds", () => {
  const sleep = AGENT_TOOLS.find(
    ({ function: definition }) => definition.name === "sleep",
  );

  if (sleep?.function.name !== "sleep") {
    throw new Error("The sleep tool definition is unavailable");
  }
  expect(sleep.function.description).toContain("duration in seconds");
  expect(sleep.function.parameters.required).toEqual(["durationSeconds"]);
  const properties = sleep.function.parameters.properties;
  const durationSeconds = properties.durationSeconds;
  expect(Object.keys(properties)).toEqual(["durationSeconds"]);
  expect(durationSeconds.description).toBe("Duration to sleep in seconds");
  // The schema default and the default global limit remain aligned.
  expect(durationSeconds.maximum).toBe(DEFAULT_EXECUTION_LIMIT_SECONDS);
  expect(durationSeconds.minimum).toBe(1);
  expect(durationSeconds.type).toBe("integer");
});

test("patches bash and sleep schemas from one snapshot", () => {
  const settings = { executionLimitMinutes: 7, outputLimitCharacters: 1_234 };
  const tools = selectedAgentTools(["bash", "sleep"], settings);
  const maximum = 7 * 60;
  const bash = tools.find(
    ({ function: definition }) => definition.name === "bash",
  );
  const sleep = tools.find(
    ({ function: definition }) => definition.name === "sleep",
  );
  expect(bash?.function.parameters).toMatchObject({
    properties: { timeout: { maximum } },
  });
  expect(sleep?.function.parameters).toMatchObject({
    properties: { durationSeconds: { maximum } },
  });
});

test("keeps sleep session-local and unavailable to parallel", () => {
  const sleep = AGENT_SESSION_TOOL_OPTIONS.find(({ name }) => name === "sleep");
  const parallel = selectedAgentTools(
    ["sleep", "parallel"],
    DEFAULT_TOOL_SETTINGS,
  );

  expect(sleep).toMatchObject({ classification: "session_tool" });
  expect(isBaseAgentToolName("sleep")).toBe(false);
  expect(parallel).toHaveLength(2);
  expectParallelRecipients(parallel, []);
});

test("defines optional agent-file path and auto-compaction for spawned sessions", () => {
  const spawnSession = AGENT_TOOLS.find(
    ({ function: definition }) => definition.name === "spawn_session",
  );
  if (spawnSession?.function.name !== "spawn_session") {
    throw new Error("The spawn-session tool definition is unavailable");
  }
  expect(spawnSession.function.parameters.required).not.toContain(
    "agentFilePath",
  );
  expect(spawnSession.function.parameters.required).not.toContain(
    "autoCompact",
  );
  expect(spawnSession).toMatchObject({
    function: {
      description:
        "Spawn another agent session and return immediately. Configure it with the same fields as the new-session pane, including any working directory and agent-file path (relative or absolute; container sessions keep agent files inside the workspace). When it finishes or fails, its last message is sent back to this session.",
      parameters: {
        properties: {
          agentFilePath: {
            description: "Optional agent-file path, relative or absolute",
            type: "string",
          },
          autoCompact: { type: "boolean" },
          workingDirectory: {
            description: "Working directory on the selected runner",
            type: "string",
          },
        },
      },
    },
  });
});

test("defines list-session pagination and search parameters", () => {
  const listSessions = AGENT_TOOLS.find(
    ({ function: definition }) => definition.name === "list_sessions",
  );

  expect(listSessions?.function.description).toContain("pagination");
  expect(listSessions).toMatchObject({
    function: {
      parameters: {
        additionalProperties: false,
        properties: {
          page: { minimum: 1, type: "integer" },
          pageSize: { maximum: 26, minimum: 1, type: "integer" },
          search: { maxLength: 100, type: "string" },
        },
        required: [],
      },
    },
  });
});

test("validates compact-session and steer-session schemas", () => {
  for (const name of ["compact_session", "steer_session"] as const) {
    const tool = AGENT_TOOLS.find(
      ({ function: definition }) => definition.name === name,
    );
    expect(tool?.function.parameters).toMatchObject({
      additionalProperties: false,
      properties: { sessionId: { type: "string" } },
      required:
        name === "compact_session" ? ["sessionId"] : ["sessionId", "message"],
    });
  }
  const steer = AGENT_TOOLS.find(
    ({ function: definition }) => definition.name === "steer_session",
  );
  expect(steer?.function.parameters.properties).toMatchObject({
    message: { type: "string" },
  });
  expect(steer?.function.description).toContain("send_to_session");
});

test("defines the session tools as one selectable group", () => {
  expect(SESSION_AGENT_TOOL_NAMES).toEqual([
    "sleep",
    "spawn_session",
    "browse_runner_directories",
    "list_runners",
    "list_sessions",
    "get_session_options",
    "read_session",
    "reassign_session",
    "send_to_session",
    "continue_session",
    "compact_session",
    "steer_session",
    "stop_session",
  ]);
  const stopTool = AGENT_TOOLS.find(
    ({ function: definition }) => definition.name === "stop_session",
  )?.function;
  expect(stopTool?.description).toContain("By default");
  expect(stopTool?.parameters).toMatchObject({
    properties: { cascade: { type: "boolean" } },
    required: ["sessionId"],
  });
  expect(
    AGENT_TOOLS.filter(({ function: definition }) =>
      SESSION_AGENT_TOOL_NAMES.includes(definition.name),
    ).map(({ function: definition }) => definition.name),
  ).toEqual(SESSION_AGENT_TOOL_NAMES);
  expect(
    AGENT_SESSION_TOOL_OPTIONS.filter(({ name }) =>
      SESSION_AGENT_TOOL_NAMES.includes(name),
    ).every(({ classification }) => classification === "session_tool"),
  ).toBe(true);
});

test("defines two or more parallel calls without an arbitrary count maximum", () => {
  const serialized: unknown = JSON.parse(JSON.stringify(AGENT_TOOLS));
  expect(Array.isArray(serialized)).toBe(true);
  const parallel = AGENT_TOOLS.find(
    ({ function: definition }) => definition.name === "parallel",
  );
  const properties: unknown = parallel?.function.parameters.properties;
  const toolUses = isRecord(properties) ? properties["tool_uses"] : undefined;

  expect(toolUses).toMatchObject({ minItems: 2, type: "array" });
  expect(isRecord(toolUses) ? toolUses["maxItems"] : "missing schema").toBe(
    undefined,
  );
  expect(JSON.stringify(parallel)).not.toContain('"maxItems"');
});

test("derives picker metadata and classifications from every tool definition", () => {
  expect(
    AGENT_SESSION_TOOL_OPTIONS.map(({ classification, definition, name }) => ({
      classification,
      definitionName: definition.name,
      name,
    })),
  ).toEqual(
    AGENT_TOOLS.map(({ function: definition }) => ({
      classification:
        definition.name === "brave_search" ||
        definition.name === "ask_questions"
          ? "skill"
          : SESSION_AGENT_TOOL_NAMES.includes(definition.name)
            ? "session_tool"
            : "runner_tool",
      definitionName: definition.name,
      name: definition.name,
    })),
  );
});

test("limits parallel calls to enabled tools and skills", () => {
  const tools = selectedAgentTools(
    ["read", "parallel", "brave_search"],
    DEFAULT_TOOL_SETTINGS,
  );

  expect(tools.map(({ function: definition }) => definition.name)).toEqual([
    "read",
    "parallel",
    "brave_search",
  ]);
  expectParallelRecipients(tools, ["read", "brave_search"]);
});
