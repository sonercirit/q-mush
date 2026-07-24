import type { AgentSessionMessage } from "../shared/session-model.ts";
import { utf8ByteLength, utf8Prefix } from "../shared/utf8.ts";

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
const MAXIMUM_READ_SESSION_OUTPUT_BYTES = 32_768;

const MAXIMUM_READ_SESSION_RECORD_BYTES = 8_000;
const MAXIMUM_READ_SESSION_SYSTEM_BYTES = 10_000;
const MAXIMUM_READ_SESSION_TOOL_SECTION_BYTES = 10_000;
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
  outputBytesTruncated: boolean;
  recordContentTruncated: boolean;
  records: ReadSessionRecord[];
  systemPrompt: string | undefined;
  systemPromptTruncated: boolean;
  toolDefinitions: ReadSessionToolDefinition[] | undefined;
}

function truncateText(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (utf8ByteLength(value) <= maximumBytes) {
    return { text: value, truncated: false };
  }
  const markerBytes = utf8ByteLength(TRUNCATION_MARKER);
  return {
    text: `${utf8Prefix(
      value,
      Math.max(0, maximumBytes - markerBytes),
    )}${TRUNCATION_MARKER}`,
    truncated: true,
  };
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
      utf8ByteLength(JSON.stringify(candidate)) >
      MAXIMUM_READ_SESSION_TOOL_SECTION_BYTES
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
  const characterCap =
    state.recordContentTruncated || state.systemPromptTruncated;
  const truncated =
    truncatedByLimit ||
    characterCap ||
    toolDefinitionsTruncated ||
    state.outputBytesTruncated;
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
        characterCap,
        limit: truncatedByLimit,
        outputBytes: state.outputBytesTruncated,
        records: state.outputBytesTruncated,
        systemPrompt: state.systemPromptTruncated,
        toolDefinitions: toolDefinitionsTruncated,
      },
    },
    session: options.session,
  };
}

function shrinkState(update: () => boolean, serialize: () => string): string {
  let output = serialize();
  while (
    utf8ByteLength(output) > MAXIMUM_READ_SESSION_OUTPUT_BYTES &&
    update()
  ) {
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
  shrinkState(() => {
    if (state.records.shift() === undefined) {
      return false;
    }
    state.outputBytesTruncated = true;
    return true;
  }, serialize);
  shrinkState(() => {
    if (
      state.systemPrompt === undefined ||
      state.systemPrompt.length <= TRUNCATION_MARKER.length
    ) {
      return false;
    }
    state.systemPrompt = truncateText(
      state.systemPrompt,
      Math.max(
        utf8ByteLength(TRUNCATION_MARKER),
        Math.floor(utf8ByteLength(state.systemPrompt) / 2),
      ),
    ).text;
    state.systemPromptTruncated = true;
    return true;
  }, serialize);
  const output = shrinkState(
    () => state.toolDefinitions?.pop() !== undefined,
    serialize,
  );

  if (utf8ByteLength(output) > MAXIMUM_READ_SESSION_OUTPUT_BYTES) {
    throw new Error(
      "The bounded session output could not be serialized safely",
    );
  }
  return output;
}

export function readSessionOutput(options: {
  readonly input: ReadSessionToolInput;
  readonly matchedRecords?: number;
  readonly messages: readonly AgentSessionMessage[];
  readonly session: ReadSessionIdentity;
  readonly systemPrompt: string;
  readonly toolDefinitions: readonly ReadSessionToolDefinition[];
}): string {
  const selected = new Set(options.input.categories);
  let recordContentTruncated = false;
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
        MAXIMUM_READ_SESSION_RECORD_BYTES,
      );
      if (content.truncated) {
        recordContentTruncated = true;
      }
      return [
        {
          content: content.text,
          createdAt: message.createdAt,
          id: message.id,
          role: message.role,
        },
      ];
    },
  );
  const boundedSystemPrompt = selected.has("system")
    ? truncateText(options.systemPrompt, MAXIMUM_READ_SESSION_SYSTEM_BYTES)
    : undefined;
  const boundedTools = selected.has("tools")
    ? toolSection(options.toolDefinitions)
    : undefined;
  const state: ReadSessionOutputState = {
    outputBytesTruncated: false,
    recordContentTruncated,
    records: matches.slice(-options.input.limit),
    systemPrompt: boundedSystemPrompt?.text,
    systemPromptTruncated: boundedSystemPrompt?.truncated ?? false,
    toolDefinitions: boundedTools?.definitions,
  };
  return serializeBoundedOutput(
    {
      categories: options.input.categories,
      matchedRecords: options.matchedRecords ?? matches.length,
      requestedLimit: options.input.limit,
      session: options.session,
      totalToolDefinitions: selected.has("tools")
        ? options.toolDefinitions.length
        : 0,
    },
    state,
  );
}
