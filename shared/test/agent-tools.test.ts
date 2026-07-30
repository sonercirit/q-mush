import { expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_OPTIONS,
  AGENT_TOOLS,
  SESSION_AGENT_TOOL_NAMES,
  isBaseAgentToolName,
  selectedAgentTools,
} from "../../shared/agent-tools.ts";
import { isRecord } from "../../shared/auth-model.ts";

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

test("keeps sleep session-local and unavailable to parallel", () => {
  const sleep = AGENT_SESSION_TOOL_OPTIONS.find(({ name }) => name === "sleep");
  const parallel = selectedAgentTools(["sleep", "parallel"]);

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
        "Spawn another agent session and return immediately. Configure it with the same fields available in the new-session pane, including any working directory and any agent-file path (relative or absolute, inside or outside the workspace). When it finishes or fails, its last message is sent back to this session.",
      parameters: {
        properties: {
          agentFilePath: {
            description:
              "Optional agent-file path; may be relative or absolute, inside or outside the workspace",
            type: "string",
          },
          autoCompact: { type: "boolean" },
          workingDirectory: {
            description:
              "Any working directory on the selected runner, inside or outside the parent workspace",
            type: "string",
          },
        },
      },
    },
  });
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
    "stop_session",
  ]);
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
  const tools = selectedAgentTools(["read", "parallel", "brave_search"]);

  expect(tools.map(({ function: definition }) => definition.name)).toEqual([
    "read",
    "parallel",
    "brave_search",
  ]);
  expectParallelRecipients(tools, ["read", "brave_search"]);
});
