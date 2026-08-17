import {
  AGENT_TOOLS,
  PARALLEL_TOOL,
  type AgentSessionToolName,
  type AgentToolDefinition,
} from "./agent-tools.ts";
import { ASK_QUESTIONS_TOOL_NAME } from "./ask-questions-tool.ts";
import {
  DEFAULT_TOOL_SETTINGS,
  toolExecutionLimitSeconds,
  type ToolSettings,
} from "./tool-limits.ts";

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
                        name !== ASK_QUESTIONS_TOOL_NAME &&
                        name !== "sleep",
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

function toolDefinitionWithSettings(
  tool: AgentToolDefinition,
  settings: ToolSettings,
): AgentToolDefinition {
  if (tool.function.name !== "bash" && tool.function.name !== "sleep") {
    return tool;
  }
  const parameters = tool.function.parameters;
  const properties = parameters["properties"];
  if (typeof properties !== "object" || properties === null) return tool;
  const propertyName =
    tool.function.name === "bash" ? "timeout" : "durationSeconds";
  const current: unknown = Reflect.get(properties, propertyName);
  if (typeof current !== "object" || current === null) return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        ...parameters,
        properties: {
          ...properties,
          [propertyName]: {
            ...current,
            maximum: toolExecutionLimitSeconds(settings),
            minimum: 1,
            type: "integer",
          },
        },
      },
    },
  };
}

export function selectedAgentTools(
  names: readonly AgentSessionToolName[],
  settings: ToolSettings = DEFAULT_TOOL_SETTINGS,
): readonly AgentToolDefinition[] {
  const selectedTools = AGENT_TOOLS.filter(({ function: definition }) =>
    names.includes(definition.name),
  ).map((tool) => toolDefinitionWithSettings(tool, settings));
  return selectedTools.map((tool) =>
    tool.function.name === PARALLEL_TOOL.function.name
      ? selectedParallelTool(selectedTools)
      : tool,
  );
}
