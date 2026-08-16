import { isRecord } from "./auth-model.ts";
import { parseOptionalJsonRecord } from "./json-record.ts";

type AnthropicReplayValue =
  | boolean
  | null
  | number
  | string
  | readonly AnthropicReplayValue[]
  | AnthropicReplayObject;

export interface AnthropicReplayObject {
  readonly [key: string]: AnthropicReplayValue;
}

type ReplayFields = Readonly<Record<string, AnthropicReplayValue>>;

type AnthropicReplayBlockType =
  | "bash_code_execution_tool_result"
  | "code_execution_tool_result"
  | "container_upload"
  | "redacted_thinking"
  | "server_tool_use"
  | "text"
  | "text_editor_code_execution_tool_result"
  | "thinking"
  | "tool_search_tool_result"
  | "tool_use"
  | "web_fetch_tool_result"
  | "web_search_tool_result";

const REPLAY_BLOCK_KEYS = {
  bash_code_execution_tool_result: ["content", "tool_use_id", "type"],
  code_execution_tool_result: ["content", "tool_use_id", "type"],
  container_upload: ["file_id", "type"],
  redacted_thinking: ["data", "type"],
  server_tool_use: ["caller", "id", "input", "name", "type"],
  text: ["citations", "text", "type"],
  text_editor_code_execution_tool_result: ["content", "tool_use_id", "type"],
  thinking: ["signature", "thinking", "type"],
  tool_search_tool_result: ["content", "tool_use_id", "type"],
  tool_use: ["caller", "id", "input", "name", "type"],
  web_fetch_tool_result: ["caller", "content", "tool_use_id", "type"],
  web_search_tool_result: ["caller", "content", "tool_use_id", "type"],
} as const satisfies Readonly<
  Record<AnthropicReplayBlockType, readonly string[]>
>;

export type AnthropicReplayBlock = ReplayFields &
  (
    | {
        readonly signature: string;
        readonly thinking: string;
        readonly type: "thinking";
      }
    | {
        readonly data: string;
        readonly type: "redacted_thinking";
      }
    | {
        readonly text: string;
        readonly type: "text";
      }
    | {
        readonly id: string;
        readonly input: AnthropicReplayValue;
        readonly name: string;
        readonly type: "server_tool_use";
      }
    | {
        readonly file_id: string;
        readonly type: "container_upload";
      }
    | {
        readonly content: AnthropicReplayValue;
        readonly tool_use_id: string;
        readonly type: AnthropicServerToolResultBlockType;
      }
    | {
        readonly id: string;
        readonly input: AnthropicReplayObject;
        readonly name: string;
        readonly type: "tool_use";
      }
  );

type AnthropicServerToolResultBlockType = Exclude<
  AnthropicReplayBlockType,
  | "container_upload"
  | "redacted_thinking"
  | "server_tool_use"
  | "text"
  | "thinking"
  | "tool_use"
>;

export interface AnthropicAssistantReplay {
  readonly blocks: readonly AnthropicReplayBlock[];
  readonly container?: string;
  readonly model: string;
  readonly protocol: "anthropic";
  readonly provenance: string;
}

export function createAnthropicAssistantReplay(
  blocks: readonly AnthropicReplayBlock[],
  identity: Pick<AnthropicAssistantReplay, "model" | "provenance">,
  container?: string,
): AnthropicAssistantReplay {
  return {
    blocks,
    ...(container === undefined ? {} : { container }),
    model: identity.model,
    protocol: "anthropic",
    provenance: identity.provenance,
  };
}

const INVALID_REPLAY = "Anthropic assistant replay data is invalid";

function isAnthropicReplayValue(value: unknown): value is AnthropicReplayValue {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value)
        ? value.every(isAnthropicReplayValue)
        : isRecord(value) && Object.values(value).every(isAnthropicReplayValue);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return false;
  }
  throw new Error("Unreachable replay value type");
}

export function isAnthropicReplayObject(
  value: unknown,
): value is AnthropicReplayObject {
  return isRecord(value) && Object.values(value).every(isAnthropicReplayValue);
}

export function projectAnthropicReplayFields(
  value: Readonly<Record<string, unknown>>,
  type: AnthropicReplayBlockType,
): AnthropicReplayObject | undefined {
  const projected = Object.fromEntries(
    REPLAY_BLOCK_KEYS[type]
      .filter((key) => key in value)
      .map((key) => [key, value[key]]),
  );
  return projected["type"] === type && isAnthropicReplayObject(projected)
    ? projected
    : undefined;
}

function hasOnlyReplayBlockKeys(
  value: Readonly<Record<string, unknown>>,
  type: AnthropicReplayBlockType,
): boolean {
  const allowed = new Set<string>(REPLAY_BLOCK_KEYS[type]);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function readAnthropicReplayBlockType(
  value: unknown,
): AnthropicReplayBlockType | undefined {
  switch (value) {
    case "thinking":
    case "redacted_thinking":
    case "text":
    case "tool_use":
    case "server_tool_use":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "code_execution_tool_result":
    case "container_upload":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
      return value;
    default:
      return undefined;
  }
}

function isValidReplayOptionalFields(
  value: AnthropicReplayObject,
  type: AnthropicReplayBlockType,
): boolean {
  if (type === "text") {
    const citations = value["citations"];
    return (
      citations === undefined ||
      citations === null ||
      (Array.isArray(citations) && citations.every(isAnthropicReplayObject))
    );
  }
  if (
    type === "tool_use" ||
    type === "server_tool_use" ||
    type === "web_fetch_tool_result" ||
    type === "web_search_tool_result"
  ) {
    const caller = value["caller"];
    return caller === undefined || isAnthropicReplayObject(caller);
  }
  return true;
}

function hasReplayToolIdentity(value: AnthropicReplayObject): boolean {
  return (
    typeof value["id"] === "string" &&
    value["id"].length > 0 &&
    typeof value["name"] === "string" &&
    value["name"].length > 0
  );
}

export function isAnthropicReplayBlock(
  value: unknown,
): value is AnthropicReplayBlock {
  if (!isAnthropicReplayObject(value)) {
    return false;
  }
  const type = readAnthropicReplayBlockType(value["type"]);
  if (type === undefined) {
    return false;
  }
  if (
    !hasOnlyReplayBlockKeys(value, type) ||
    !isValidReplayOptionalFields(value, type)
  ) {
    return false;
  }
  switch (type) {
    case "thinking":
      return (
        typeof value["thinking"] === "string" &&
        typeof value["signature"] === "string" &&
        value["signature"].length > 0
      );
    case "redacted_thinking":
      return typeof value["data"] === "string" && value["data"].length > 0;
    case "text":
      // Whitespace-only text still belongs to the assistant message that the
      // replay has to reproduce exactly; only empty text is dropped, because
      // the Messages API rejects blank text blocks.
      return typeof value["text"] === "string" && value["text"].length > 0;
    case "tool_use":
      return (
        hasReplayToolIdentity(value) && isAnthropicReplayObject(value["input"])
      );
    case "server_tool_use":
      return (
        hasReplayToolIdentity(value) && isAnthropicReplayValue(value["input"])
      );
    case "container_upload":
      return (
        typeof value["file_id"] === "string" && value["file_id"].length > 0
      );
    case "bash_code_execution_tool_result":
    case "code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "web_fetch_tool_result":
    case "web_search_tool_result":
      return (
        typeof value["tool_use_id"] === "string" &&
        value["tool_use_id"].length > 0 &&
        isAnthropicReplayValue(value["content"])
      );
  }
}

function readAnthropicAssistantReplay(
  value: unknown,
): AnthropicAssistantReplay | undefined {
  if (
    !isRecord(value) ||
    value["protocol"] !== "anthropic" ||
    typeof value["model"] !== "string" ||
    value["model"].length === 0 ||
    typeof value["provenance"] !== "string" ||
    value["provenance"].length === 0 ||
    (value["container"] !== undefined &&
      (typeof value["container"] !== "string" ||
        value["container"].length === 0)) ||
    !Object.keys(value).every((key) =>
      ["blocks", "container", "model", "protocol", "provenance"].includes(key),
    ) ||
    !Array.isArray(value["blocks"]) ||
    value["blocks"].length === 0 ||
    !value["blocks"].every(isAnthropicReplayBlock)
  ) {
    return undefined;
  }
  return createAnthropicAssistantReplay(
    value["blocks"],
    { model: value["model"], provenance: value["provenance"] },
    value["container"],
  );
}

export function parseAnthropicAssistantReplay(
  value: string | null,
): AnthropicAssistantReplay | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    const replay = readAnthropicAssistantReplay(JSON.parse(value));
    if (replay !== undefined) {
      return replay;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error(INVALID_REPLAY);
}

export function serializeAnthropicAssistantReplay(
  value: AnthropicAssistantReplay | undefined,
): string | null {
  if (value === undefined) {
    return null;
  }
  return readAnthropicAssistantReplay(value) === undefined
    ? null
    : JSON.stringify(value);
}

interface ReplayToolCall {
  readonly arguments: string;
  readonly id: string;
  readonly name: string;
}

export function anthropicReplayBlocksForRequest(
  blocks: readonly AnthropicReplayBlock[],
): readonly AnthropicReplayBlock[] {
  // Anthropic rejects blank text blocks, so whitespace-only text is kept for
  // matching but withheld from the request.
  return blocks.filter(
    (block) => block.type !== "text" || block.text.trim().length > 0,
  );
}

export function anthropicReplayMatchesAssistant(
  replay: AnthropicAssistantReplay,
  content: string,
  toolCalls: readonly ReplayToolCall[],
): boolean {
  const replayText = replay.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const replayCalls = replay.blocks.filter(
    (block) => block.type === "tool_use",
  );
  return (
    replayText === content &&
    replayCalls.length === toolCalls.length &&
    replayCalls.every((block, index) => {
      const call = toolCalls[index];
      const input =
        call === undefined
          ? undefined
          : parseOptionalJsonRecord(call.arguments);
      return (
        call?.id === block.id &&
        call.name === block.name &&
        input !== undefined &&
        JSON.stringify(input) === JSON.stringify(block.input)
      );
    })
  );
}
