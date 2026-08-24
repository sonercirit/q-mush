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
  readonly requestModel?: string;
}

export function createAnthropicAssistantReplay(
  blocks: readonly AnthropicReplayBlock[],
  identity: Pick<
    AnthropicAssistantReplay,
    "model" | "provenance" | "requestModel"
  >,
  container?: string,
): AnthropicAssistantReplay {
  return {
    blocks,
    ...(container === undefined ? {} : { container }),
    model: identity.model,
    protocol: "anthropic",
    provenance: identity.provenance,
    ...(identity.requestModel === undefined ||
    identity.requestModel === identity.model
      ? {}
      : { requestModel: identity.requestModel }),
  };
}

export function anthropicReplayRequestModel(
  replay: Pick<AnthropicAssistantReplay, "model" | "requestModel">,
): string {
  return replay.requestModel ?? replay.model;
}

const INVALID_REPLAY = "Anthropic assistant replay data is invalid";

type ReplayValueType = ReturnType<typeof replayValueType>;

function replayValueType(value: unknown) {
  return typeof value;
}

const replayValueReaders: Record<ReplayValueType, (value: unknown) => boolean> =
  {
    bigint: () => false,
    boolean: () => true,
    function: () => false,
    number: (value) => typeof value === "number" && Number.isFinite(value),
    object: (value) =>
      value === null ||
      (Array.isArray(value)
        ? value.every(isAnthropicReplayValue)
        : isRecord(value) &&
          Object.values(value).every(isAnthropicReplayValue)),
    string: () => true,
    symbol: () => false,
    undefined: () => false,
  };

function isAnthropicReplayValue(value: unknown): value is AnthropicReplayValue {
  return replayValueReaders[replayValueType(value)](value);
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
  // Replay is an exact provider artifact. Validate every value as JSON-safe,
  // but retain additive fields so a newer provider block is never persisted
  // or replayed as a lossy projection.
  return value["type"] === type && isAnthropicReplayObject(value)
    ? value
    : undefined;
}

const replayBlockTypeReaders: Record<
  AnthropicReplayBlockType,
  () => AnthropicReplayBlockType
> = {
  bash_code_execution_tool_result: () => "bash_code_execution_tool_result",
  code_execution_tool_result: () => "code_execution_tool_result",
  container_upload: () => "container_upload",
  redacted_thinking: () => "redacted_thinking",
  server_tool_use: () => "server_tool_use",
  text: () => "text",
  text_editor_code_execution_tool_result: () =>
    "text_editor_code_execution_tool_result",
  thinking: () => "thinking",
  tool_search_tool_result: () => "tool_search_tool_result",
  tool_use: () => "tool_use",
  web_fetch_tool_result: () => "web_fetch_tool_result",
  web_search_tool_result: () => "web_search_tool_result",
};

function isAnthropicReplayBlockType(
  value: string,
): value is AnthropicReplayBlockType {
  return Object.hasOwn(replayBlockTypeReaders, value);
}

export function readAnthropicReplayBlockType(
  value: unknown,
): AnthropicReplayBlockType | undefined {
  return typeof value === "string" && isAnthropicReplayBlockType(value)
    ? replayBlockTypeReaders[value]()
    : undefined;
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

function hasValidToolResult(value: AnthropicReplayObject): boolean {
  return (
    typeof value["tool_use_id"] === "string" &&
    value["tool_use_id"].length > 0 &&
    isAnthropicReplayValue(value["content"])
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
  if (!isValidReplayOptionalFields(value, type)) {
    return false;
  }
  const readers: Record<
    AnthropicReplayBlockType,
    (block: AnthropicReplayObject) => boolean
  > = {
    thinking: (block) =>
      typeof block["thinking"] === "string" &&
      typeof block["signature"] === "string" &&
      block["signature"].length > 0,
    redacted_thinking: (block) =>
      typeof block["data"] === "string" && block["data"].length > 0,
    text: (block) =>
      // Whitespace-only text must be retained; the API rejects only blank text.
      typeof block["text"] === "string" && block["text"].length > 0,
    tool_use: (block) =>
      hasReplayToolIdentity(block) && isAnthropicReplayObject(block["input"]),
    server_tool_use: (block) =>
      hasReplayToolIdentity(block) && isAnthropicReplayValue(block["input"]),
    container_upload: (block) =>
      typeof block["file_id"] === "string" && block["file_id"].length > 0,
    bash_code_execution_tool_result: hasValidToolResult,
    code_execution_tool_result: hasValidToolResult,
    text_editor_code_execution_tool_result: hasValidToolResult,
    tool_search_tool_result: hasValidToolResult,
    web_fetch_tool_result: hasValidToolResult,
    web_search_tool_result: hasValidToolResult,
  };
  return readers[type](value);
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
    (value["requestModel"] !== undefined &&
      (typeof value["requestModel"] !== "string" ||
        value["requestModel"].length === 0)) ||
    (value["container"] !== undefined &&
      (typeof value["container"] !== "string" ||
        value["container"].length === 0)) ||
    !Object.keys(value).every((key) =>
      [
        "blocks",
        "container",
        "model",
        "protocol",
        "provenance",
        "requestModel",
      ].includes(key),
    ) ||
    !Array.isArray(value["blocks"]) ||
    value["blocks"].length === 0 ||
    !value["blocks"].every(isAnthropicReplayBlock)
  ) {
    return undefined;
  }
  return createAnthropicAssistantReplay(
    value["blocks"],
    {
      model: value["model"],
      provenance: value["provenance"],
      ...(typeof value["requestModel"] === "string"
        ? { requestModel: value["requestModel"] }
        : {}),
    },
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

export function anthropicReplayAssistantText(
  blocks: readonly AnthropicReplayBlock[],
): string {
  return blocks.reduce(
    (content, block) =>
      block.type === "text" ? content + block.text : content,
    "",
  );
}

export function anthropicReplayMatchesAssistant(
  replay: AnthropicAssistantReplay,
  content: string,
  toolCalls: readonly ReplayToolCall[],
): boolean {
  const replayText = anthropicReplayAssistantText(replay.blocks);
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
