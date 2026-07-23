import type { AgentSessionMessage } from "../shared/session-model.ts";

export const READ_SESSION_CATEGORIES = [
  "system",
  "user",
  "assistant",
  "tools",
] as const;
export type ReadSessionCategory = (typeof READ_SESSION_CATEGORIES)[number];

export const DEFAULT_READ_SESSION_CATEGORIES: readonly ReadSessionCategory[] = [
  "user",
  "assistant",
];
export const DEFAULT_READ_SESSION_LIMIT = 20;
export const MAXIMUM_READ_SESSION_LIMIT = 100;
const MAXIMUM_READ_SESSION_OUTPUT_CHARACTERS = 32_768;

const MAXIMUM_READ_SESSION_RECORD_CHARACTERS = 8_000;
const MAXIMUM_READ_SESSION_SYSTEM_CHARACTERS = 10_000;
const MAXIMUM_READ_SESSION_TOOL_SECTION_CHARACTERS = 10_000;
const TRUNCATION_MARKER = "\n[truncated]";

export interface ReadSessionToolInput {
  readonly categories: readonly ReadSessionCategory[];
  readonly limit: number;
  readonly sessionId: string;
}

interface ReadSessionRecord {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly role: "assistant" | "user";
}

interface ReadSessionToolDefinition {
  readonly description: string;
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

interface ReadSessionIdentity {
  readonly id: string;
  readonly status: string;
  readonly title: string;
}

interface ReadSessionOutputOptions {
  readonly categories: readonly ReadSessionCategory[];
  readonly matchedRecords: number;
  readonly requestedLimit: number;
  readonly session: ReadSessionIdentity;
  readonly totalToolDefinitions: number;
}

interface ReadSessionOutputState {
  characterTruncated: boolean;
  records: ReadSessionRecord[];
  systemPrompt: string | undefined;
  toolDefinitions: ReadSessionToolDefinition[] | undefined;
}

function truncateText(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

function toolSection(definitions: readonly ReadSessionToolDefinition[]): {
  readonly definitions: ReadSessionToolDefinition[];
  readonly truncated: boolean;
} {
  const selected: ReadSessionToolDefinition[] = [];
  let truncated = false;
  for (const definition of definitions) {
    const candidate = [...selected, definition];
    if (
      JSON.stringify(candidate).length >
      MAXIMUM_READ_SESSION_TOOL_SECTION_CHARACTERS
    ) {
      truncated = true;
      continue;
    }
    selected.push(definition);
  }
  return { definitions: selected, truncated };
}

function createOutput(
  options: ReadSessionOutputOptions,
  state: ReadSessionOutputState,
): Readonly<Record<string, unknown>> {
  const truncatedByLimit = options.matchedRecords > options.requestedLimit;
  const returnedToolDefinitions = state.toolDefinitions?.length ?? 0;
  const toolDefinitionsTruncated =
    state.toolDefinitions !== undefined &&
    returnedToolDefinitions < options.totalToolDefinitions;
  const truncated =
    truncatedByLimit || state.characterTruncated || toolDefinitionsTruncated;
  return {
    content: {
      records: state.records,
      ...(state.systemPrompt === undefined
        ? {}
        : { systemPrompt: state.systemPrompt }),
      ...(state.toolDefinitions === undefined
        ? {}
        : { toolDefinitions: state.toolDefinitions }),
    },
    metadata: {
      matchedRecords: options.matchedRecords,
      requestedLimit: options.requestedLimit,
      returnedRecords: state.records.length,
      selectedCategories: options.categories,
      toolDefinitions: {
        matched: options.totalToolDefinitions,
        returned: returnedToolDefinitions,
      },
      truncated,
      truncation: {
        characterCap: state.characterTruncated,
        limit: truncatedByLimit,
        systemPrompt: state.systemPrompt?.endsWith(TRUNCATION_MARKER) === true,
        toolDefinitions: toolDefinitionsTruncated,
      },
    },
    session: options.session,
  };
}

function shrinkState(
  state: ReadSessionOutputState,
  update: () => boolean,
  serialize: () => string,
): string {
  let output = serialize();
  while (output.length > MAXIMUM_READ_SESSION_OUTPUT_CHARACTERS && update()) {
    state.characterTruncated = true;
    output = serialize();
  }
  return output;
}

function serializeBoundedOutput(
  options: Parameters<typeof createOutput>[0],
  state: ReadSessionOutputState,
): string {
  const serialize = (): string =>
    JSON.stringify(createOutput(options, state), null, 2);
  shrinkState(state, () => state.records.shift() !== undefined, serialize);
  shrinkState(
    state,
    () => {
      if (
        state.systemPrompt === undefined ||
        state.systemPrompt.length <= TRUNCATION_MARKER.length
      ) {
        return false;
      }
      state.systemPrompt = truncateText(
        state.systemPrompt,
        Math.max(
          TRUNCATION_MARKER.length,
          Math.floor(state.systemPrompt.length / 2),
        ),
      );
      return true;
    },
    serialize,
  );
  const output = shrinkState(
    state,
    () => state.toolDefinitions?.pop() !== undefined,
    serialize,
  );

  if (output.length > MAXIMUM_READ_SESSION_OUTPUT_CHARACTERS) {
    throw new Error(
      "The bounded session output could not be serialized safely",
    );
  }
  return output;
}

export function readSessionOutput(options: {
  readonly input: ReadSessionToolInput;
  readonly messages: readonly AgentSessionMessage[];
  readonly session: ReadSessionIdentity;
  readonly systemPrompt: string;
  readonly toolDefinitions: readonly ReadSessionToolDefinition[];
}): string {
  const selected = new Set(options.input.categories);
  let characterTruncated = false;
  const matches = options.messages.flatMap(
    (message): readonly ReadSessionRecord[] => {
      if (
        (message.role !== "user" && message.role !== "assistant") ||
        !selected.has(message.role)
      ) {
        return [];
      }
      const content = truncateText(
        message.content,
        MAXIMUM_READ_SESSION_RECORD_CHARACTERS,
      );
      if (content.length < message.content.length) {
        characterTruncated = true;
      }
      return [
        {
          content,
          createdAt: message.createdAt,
          id: message.id,
          role: message.role,
        },
      ];
    },
  );
  const systemPrompt = selected.has("system")
    ? truncateText(options.systemPrompt, MAXIMUM_READ_SESSION_SYSTEM_CHARACTERS)
    : undefined;
  if (
    systemPrompt !== undefined &&
    systemPrompt.length < options.systemPrompt.length
  ) {
    characterTruncated = true;
  }
  const boundedTools = toolSection(options.toolDefinitions);
  if (selected.has("tools") && boundedTools.truncated) {
    characterTruncated = true;
  }
  const state: ReadSessionOutputState = {
    characterTruncated,
    records: matches.slice(-options.input.limit),
    systemPrompt,
    toolDefinitions: selected.has("tools")
      ? boundedTools.definitions
      : undefined,
  };
  return serializeBoundedOutput(
    {
      categories: options.input.categories,
      matchedRecords: matches.length,
      requestedLimit: options.input.limit,
      session: options.session,
      totalToolDefinitions: selected.has("tools")
        ? options.toolDefinitions.length
        : 0,
    },
    state,
  );
}
