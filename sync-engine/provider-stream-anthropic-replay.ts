import {
  createAnthropicAssistantReplay,
  isAnthropicReplayBlock,
  isAnthropicReplayObject,
  projectAnthropicReplayFields,
  readAnthropicReplayBlockType,
  type AnthropicAssistantReplay,
  type AnthropicReplayBlock,
  type AnthropicReplayObject,
} from "../shared/anthropic-replay.ts";
import { isRecord } from "../shared/auth-model.ts";

interface MutableThinkingBlock {
  readonly fields: AnthropicReplayObject;
  readonly signature: string;
  readonly thinking: string;
  readonly type: "streamed_thinking";
}

interface MutableRedactedBlock {
  readonly data: string;
  readonly fields: AnthropicReplayObject;
  readonly type: "streamed_redacted_thinking";
}

interface MutableTextBlock {
  readonly fields: AnthropicReplayObject;
  readonly text: string;
  readonly type: "streamed_text";
}

interface MutableToolBlock {
  readonly arguments: string;
  readonly fields: AnthropicReplayObject;
  readonly initialInput: AnthropicReplayObject;
  readonly type: "streamed_tool_use";
}

type MutableReplayBlock =
  | MutableThinkingBlock
  | MutableRedactedBlock
  | MutableTextBlock
  | MutableToolBlock
  | MutableServerToolBlock
  | AnthropicReplayBlock;

interface MutableServerToolBlock {
  readonly fields: AnthropicReplayObject;
  readonly initialInput: unknown;
  readonly partialInput: string;
  readonly type: "streamed_server_tool_use";
}

interface ReplayEntry {
  readonly block: MutableReplayBlock;
  readonly stopped: boolean;
}

type ReplayCompletion =
  | { readonly block?: AnthropicReplayBlock; readonly valid: true }
  | { readonly valid: false };

function optionalBlockString(value: unknown): string | undefined {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : undefined;
}

function validToolIdentity(id: string, name: string): boolean {
  return (
    id.length > 0 && id.trim() === id && name.length > 0 && name.trim() === name
  );
}

function replayObjectArray(
  value: unknown,
): readonly AnthropicReplayObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: readonly unknown[] = value;
  return values.every(isAnthropicReplayObject) ? values : undefined;
}

function initialTextBlock(
  block: Readonly<Record<string, unknown>>,
  fields: AnthropicReplayObject,
): MutableTextBlock | undefined {
  const text = optionalBlockString(block["text"]);
  const citations = fields["citations"];
  if (
    text === undefined ||
    (citations !== undefined &&
      citations !== null &&
      replayObjectArray(citations) === undefined)
  ) {
    return undefined;
  }
  return { fields, text, type: "streamed_text" };
}

interface StreamedToolIdentity {
  readonly caller?: AnthropicReplayObject;
  readonly id: string;
  readonly name: string;
}

function streamedToolIdentity(
  block: Readonly<Record<string, unknown>>,
  fields: AnthropicReplayObject,
): StreamedToolIdentity | undefined {
  const id = block["id"];
  const name = block["name"];
  const caller = fields["caller"];
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !validToolIdentity(id, name) ||
    (caller !== undefined && !isAnthropicReplayObject(caller))
  ) {
    return undefined;
  }
  return { ...(caller === undefined ? {} : { caller }), id, name };
}

function initialToolBlock(
  block: Readonly<Record<string, unknown>>,
  fields: AnthropicReplayObject,
): MutableToolBlock | undefined {
  const identity = streamedToolIdentity(block, fields);
  const candidateInput = block["input"] ?? {};
  if (identity === undefined || !isAnthropicReplayObject(candidateInput)) {
    return undefined;
  }
  return {
    arguments: "",
    fields,
    initialInput: candidateInput,
    type: "streamed_tool_use",
  };
}

function initialServerToolBlock(
  block: Readonly<Record<string, unknown>>,
  fields: AnthropicReplayObject,
): MutableServerToolBlock | undefined {
  const identity = streamedToolIdentity(block, fields);
  const input = block["input"] ?? {};
  if (identity === undefined || !isAnthropicReplayBlock({ ...fields, input })) {
    return undefined;
  }
  return {
    fields,
    initialInput: input,
    partialInput: "",
    type: "streamed_server_tool_use",
  };
}

type ReplayRecord = Readonly<Record<string, unknown>>;
type IndexedReplayBlock = readonly [
  index: number | undefined,
  block: ReplayRecord,
];

function initialReplayBlock(
  block: ReplayRecord,
): MutableReplayBlock | undefined {
  const type = readAnthropicReplayBlockType(block["type"]);
  if (type === undefined) return undefined;
  const fields = projectAnthropicReplayFields(block, type);
  if (fields === undefined) return undefined;
  if (type === "text") return initialTextBlock(block, fields);
  if (type === "tool_use") return initialToolBlock(block, fields);
  if (type === "server_tool_use") return initialServerToolBlock(block, fields);
  if (type === "thinking") {
    const thinking = optionalBlockString(block["thinking"]);
    const signature = optionalBlockString(block["signature"]);
    return thinking === undefined || signature === undefined
      ? undefined
      : { fields, signature, thinking, type: "streamed_thinking" };
  }
  if (type === "redacted_thinking") {
    const data = optionalBlockString(block["data"]);
    return data === undefined
      ? undefined
      : { data, fields, type: "streamed_redacted_thinking" };
  }
  return isAnthropicReplayBlock(fields) ? fields : undefined;
}

function completedJsonInput(initialInput: unknown, delta: string): unknown {
  if (delta.length === 0) return initialInput;
  try {
    return JSON.parse(delta);
  } catch {
    return undefined;
  }
}

function completedToolFields<Input>(
  block: MutableToolBlock | MutableServerToolBlock,
  input: Input,
) {
  return { ...block.fields, input };
}

function completedCandidate(value: unknown): ReplayCompletion {
  return isAnthropicReplayBlock(value)
    ? { block: value, valid: true }
    : { valid: false };
}

function completedToolBlock(block: MutableToolBlock): ReplayCompletion {
  const input = completedJsonInput(block.initialInput, block.arguments);
  return isAnthropicReplayObject(input)
    ? completedCandidate({ ...block.fields, input, type: "tool_use" })
    : { valid: false };
}

function completedServerToolBlock(
  block: MutableServerToolBlock,
): ReplayCompletion {
  const input = completedJsonInput(block.initialInput, block.partialInput);
  return completedCandidate({
    ...completedToolFields(block, input),
    type: "server_tool_use",
  });
}

function completedStringBlock(
  block: MutableThinkingBlock | MutableRedactedBlock,
  value: string,
): ReplayCompletion {
  const completed =
    block.type === "streamed_thinking"
      ? {
          ...block.fields,
          signature: block.signature,
          thinking: block.thinking,
        }
      : { ...block.fields, data: block.data };
  return value.length === 0 ? { valid: false } : completedCandidate(completed);
}

type MutableReplayBlockType = MutableReplayBlock["type"];
type ReplayCompletionHandler = (block: MutableReplayBlock) => ReplayCompletion;

const completedReplayHandlers: Record<
  MutableReplayBlockType,
  ReplayCompletionHandler
> = {
  bash_code_execution_tool_result: (block) => completedCandidate(block),
  code_execution_tool_result: (block) => completedCandidate(block),
  container_upload: (block) => completedCandidate(block),
  redacted_thinking: (block) => completedCandidate(block),
  server_tool_use: (block) => completedCandidate(block),
  streamed_redacted_thinking: (block) =>
    block.type === "streamed_redacted_thinking"
      ? completedStringBlock(block, block.data)
      : { valid: false },
  streamed_server_tool_use: (block) =>
    block.type === "streamed_server_tool_use"
      ? completedServerToolBlock(block)
      : { valid: false },
  streamed_text: (block) => {
    if (block.type !== "streamed_text") return { valid: false };
    return block.text.length === 0
      ? { valid: true }
      : completedCandidate({ ...block.fields, text: block.text });
  },
  streamed_thinking: (block) =>
    block.type === "streamed_thinking"
      ? completedStringBlock(block, block.signature)
      : { valid: false },
  streamed_tool_use: (block) =>
    block.type === "streamed_tool_use"
      ? completedToolBlock(block)
      : { valid: false },
  text: (block) => completedCandidate(block),
  text_editor_code_execution_tool_result: (block) => completedCandidate(block),
  thinking: (block) => completedCandidate(block),
  tool_search_tool_result: (block) => completedCandidate(block),
  tool_use: (block) => completedCandidate(block),
  web_fetch_tool_result: (block) => completedCandidate(block),
  web_search_tool_result: (block) => completedCandidate(block),
};

function completedReplayBlock(block: MutableReplayBlock): ReplayCompletion {
  return completedReplayHandlers[block.type](block);
}

export interface AnthropicReplayCapture {
  readonly complete: (...[index, block]: IndexedReplayBlock) => void;
  readonly delta: (
    index: number | undefined,
    delta: Readonly<Record<string, unknown>>,
  ) => void;
  readonly finish: () => AnthropicAssistantReplay | undefined;
  readonly invalidate: () => void;
  readonly readContainer: (value: unknown) => void;
  readonly readModel: (value: unknown) => void;
  readonly start: (...[index, block]: IndexedReplayBlock) => void;
  readonly stop: (index: number | undefined) => void;
}

export function createAnthropicReplayCapture(
  provenance: string,
): AnthropicReplayCapture {
  const entries = new Map<number, ReplayEntry>();
  let available = true;
  let container: string | undefined;
  let model: string | undefined;

  const unavailable = (): false => {
    available = false;
    return false;
  };
  const invalidate = (): void => {
    unavailable();
  };
  const readModel = (value: unknown): void => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      (model !== undefined && model !== value)
    ) {
      invalidate();
      return;
    }
    model = value;
  };
  const readContainer = (value: unknown): void => {
    if (value === undefined || value === null) return;
    const id = isRecord(value) ? value["id"] : undefined;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      (container !== undefined && container !== id)
    ) {
      invalidate();
      return;
    }
    container = id;
  };
  const store = (
    index: number | undefined,
    entry: ReplayEntry | undefined,
  ): void => {
    if (index === undefined || entry === undefined) invalidate();
    else entries.set(index, entry);
  };
  const update = (
    index: number | undefined,
    mutation: (entry: ReplayEntry) => ReplayEntry | undefined,
  ): void => {
    const entry = index === undefined ? undefined : entries.get(index);
    store(index, entry === undefined ? undefined : mutation(entry));
  };
  const start = (...[index, block]: IndexedReplayBlock): void => {
    const replayBlock = initialReplayBlock(block);
    const duplicate = index !== undefined && entries.has(index);
    store(
      index,
      duplicate || replayBlock === undefined
        ? undefined
        : { block: replayBlock, stopped: false },
    );
  };
  const delta = (
    index: number | undefined,
    value: Readonly<Record<string, unknown>>,
  ): void => {
    update(index, (entry) => {
      const block = updatedReplayBlock(entry.block, value);
      return block === undefined ? undefined : { ...entry, block };
    });
  };
  const stop = (index: number | undefined): void => {
    update(index, (entry) =>
      entry.stopped ? undefined : { ...entry, stopped: true },
    );
  };
  const complete = (...[index, block]: IndexedReplayBlock): void => {
    start(index, block);
    stop(index);
  };
  const finish = (): AnthropicAssistantReplay | undefined => {
    if (
      !available ||
      model === undefined ||
      [...entries.values()].some(({ stopped }) => !stopped)
    ) {
      return undefined;
    }
    const blocks: AnthropicReplayBlock[] = [];
    const sortedEntries = Array.from(entries.entries());
    sortedEntries.sort((left, right) => left[0] - right[0]);
    for (const [, { block }] of sortedEntries) {
      const completed = completedReplayBlock(block);
      if (!completed.valid) return undefined;
      if (completed.block !== undefined) blocks.push(completed.block);
    }
    return blocks.length === 0
      ? undefined
      : createAnthropicAssistantReplay(
          blocks,
          { model, provenance },
          container,
        );
  };

  return {
    complete,
    delta,
    finish,
    invalidate,
    readContainer,
    readModel,
    start,
    stop,
  };
}

function appendCitation(
  block: MutableReplayBlock,
  citation: unknown,
): MutableTextBlock | undefined {
  if (block.type !== "streamed_text" || !isAnthropicReplayObject(citation)) {
    return undefined;
  }
  const citations = block.fields["citations"];
  if (
    citations !== undefined &&
    citations !== null &&
    !replayObjectArray(citations)
  ) {
    return undefined;
  }
  const existing = replayObjectArray(citations) ?? [];
  return {
    ...block,
    fields: { ...block.fields, citations: [...existing, citation] },
  };
}

function appendServerToolInput(
  block: MutableServerToolBlock,
  partialJson: string,
): MutableServerToolBlock {
  return { ...block, partialInput: block.partialInput + partialJson };
}

type ReplayDeltaType =
  | "citations_delta"
  | "input_json_delta"
  | "signature_delta"
  | "text_delta"
  | "thinking_delta";

type ReplayDeltaHandler = (
  block: MutableReplayBlock,
  delta: Readonly<Record<string, unknown>>,
) => MutableReplayBlock | undefined;

const replayDeltaHandlers: Record<ReplayDeltaType, ReplayDeltaHandler> = {
  citations_delta: (block, delta) => appendCitation(block, delta["citation"]),
  input_json_delta: (block, delta) =>
    block.type === "streamed_tool_use" &&
    typeof delta["partial_json"] === "string"
      ? { ...block, arguments: block.arguments + delta["partial_json"] }
      : block.type === "streamed_server_tool_use" &&
          typeof delta["partial_json"] === "string"
        ? appendServerToolInput(block, delta["partial_json"])
        : undefined,
  signature_delta: (block, delta) =>
    block.type === "streamed_thinking" && typeof delta["signature"] === "string"
      ? { ...block, signature: block.signature + delta["signature"] }
      : undefined,
  text_delta: (block, delta) =>
    block.type === "streamed_text" && typeof delta["text"] === "string"
      ? { ...block, text: block.text + delta["text"] }
      : undefined,
  thinking_delta: (block, delta) =>
    block.type === "streamed_thinking" && typeof delta["thinking"] === "string"
      ? { ...block, thinking: block.thinking + delta["thinking"] }
      : undefined,
};

function isReplayDeltaType(value: unknown): value is ReplayDeltaType {
  return typeof value === "string" && value in replayDeltaHandlers;
}

function updatedReplayBlock(
  block: MutableReplayBlock,
  delta: ReplayRecord,
): MutableReplayBlock | undefined {
  const type = delta["type"];
  return isReplayDeltaType(type)
    ? replayDeltaHandlers[type](block, delta)
    : undefined;
}
