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
  "redacted_thinking" | "text" | "thinking" | "tool_use";

const REPLAY_BLOCK_KEYS = {
  redacted_thinking: ["data", "type"],
  text: ["citations", "text", "type"],
  thinking: ["signature", "thinking", "type"],
  tool_use: ["caller", "id", "input", "name", "type"],
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
        readonly input: AnthropicReplayObject;
        readonly name: string;
        readonly type: "tool_use";
      }
  );

export interface AnthropicAssistantReplay {
  readonly blocks: readonly AnthropicReplayBlock[];
  readonly model: string;
  readonly protocol: "anthropic";
  readonly provenance: string;
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
      return value;
    default:
      return undefined;
  }
}

function isReplayBlock(value: unknown): value is AnthropicReplayBlock {
  if (!isAnthropicReplayObject(value)) {
    return false;
  }
  const type = readAnthropicReplayBlockType(value["type"]);
  if (type === undefined) {
    return false;
  }
  if (!hasOnlyReplayBlockKeys(value, type)) {
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
      return typeof value["text"] === "string";
    case "tool_use":
      return (
        typeof value["id"] === "string" &&
        value["id"].length > 0 &&
        typeof value["name"] === "string" &&
        value["name"].length > 0 &&
        isAnthropicReplayObject(value["input"])
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
    !Object.keys(value).every((key) =>
      ["blocks", "model", "protocol", "provenance"].includes(key),
    ) ||
    !Array.isArray(value["blocks"]) ||
    value["blocks"].length === 0 ||
    !value["blocks"].every(isReplayBlock)
  ) {
    return undefined;
  }
  return {
    blocks: value["blocks"],
    model: value["model"],
    protocol: "anthropic",
    provenance: value["provenance"],
  };
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
