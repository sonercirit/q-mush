import { expect, test } from "vitest";
import {
  AGENT_SESSION_TOOL_OPTIONS,
  AGENT_TOOLS,
  SESSION_AGENT_TOOL_NAMES,
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

test("defines page_fetch as a selectable browser-rendered page tool", () => {
  const definition = AGENT_TOOLS.find(
    ({ function: tool }) => tool.name === "page_fetch",
  );
  const option = AGENT_SESSION_TOOL_OPTIONS.find(
    ({ name }) => name === "page_fetch",
  );

  expect(definition).toMatchObject({
    function: {
      name: "page_fetch",
      parameters: {
        additionalProperties: false,
        properties: {
          timeout: { maximum: 120, minimum: 1, type: "integer" },
          url: { type: "string" },
        },
        required: ["url"],
        type: "object",
      },
    },
    type: "function",
  });
  expect(definition?.function.description).toContain("JavaScript");
  expect(option).toMatchObject({
    classification: "runner_tool",
    label: "Fetch page",
    name: "page_fetch",
  });
});

test("lets parallel call every tool and skill except itself by default", () => {
  expectParallelRecipients(AGENT_TOOLS, [
    "read",
    "bash",
    "edit",
    "write",
    "page_fetch",
    "brave_search",
    ...SESSION_AGENT_TOOL_NAMES,
  ]);
});

test("defines the session tools as one selectable group", () => {
  expect(SESSION_AGENT_TOOL_NAMES).toEqual([
    "spawn_session",
    "list_sessions",
    "read_session",
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
        definition.name === "brave_search"
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
  const tools = selectedAgentTools([
    "read",
    "parallel",
    "page_fetch",
    "brave_search",
  ]);

  expect(tools.map(({ function: definition }) => definition.name)).toEqual([
    "read",
    "page_fetch",
    "parallel",
    "brave_search",
  ]);
  expectParallelRecipients(tools, ["read", "page_fetch", "brave_search"]);
});
