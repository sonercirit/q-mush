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

function initialReplayBlock(
  block: Readonly<Record<string, unknown>>,
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

function completedReplayBlock(block: MutableReplayBlock): ReplayCompletion {
  switch (block.type) {
    case "streamed_thinking":
      return completedStringBlock(block, block.signature);
    case "streamed_redacted_thinking":
      return completedStringBlock(block, block.data);
    case "streamed_text": {
      if (block.text.length === 0) return { valid: true };
      return completedCandidate({ ...block.fields, text: block.text });
    }
    case "streamed_tool_use":
      return completedToolBlock(block);
    case "streamed_server_tool_use":
      return completedServerToolBlock(block);
    case "redacted_thinking":
    case "thinking":
    case "text":
    case "bash_code_execution_tool_result":
    case "code_execution_tool_result":
    case "container_upload":
    case "server_tool_use":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "tool_use":
    case "web_fetch_tool_result":
    case "web_search_tool_result":
      return { block, valid: true };
  }
}

export class AnthropicReplayCapture {
  readonly #entries = new Map<number, ReplayEntry>();
  #available = true;
  #container: string | undefined;
  #model: string | undefined;
  readonly #provenance: string;

  constructor(provenance: string) {
    this.#provenance = provenance;
  }

  #unavailable(): false {
    this.#available = false;
    return false;
  }

  invalidate(): void {
    this.#unavailable();
  }

  readModel(value: unknown): void {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      (this.#model !== undefined && this.#model !== value)
    ) {
      this.invalidate();
      return;
    }
    this.#model = value;
  }

  readContainer(value: unknown): void {
    if (value === undefined || value === null) return;
    const id = isRecord(value) ? value["id"] : undefined;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      (this.#container !== undefined && this.#container !== id)
    ) {
      this.invalidate();
      return;
    }
    this.#container = id;
  }

  #store(index: number | undefined, entry: ReplayEntry | undefined): void {
    if (index === undefined || entry === undefined) {
      this.invalidate();
    } else {
      this.#entries.set(index, entry);
    }
  }

  #update(
    index: number | undefined,
    mutation: (entry: ReplayEntry) => ReplayEntry | undefined,
  ): void {
    const entry = index === undefined ? undefined : this.#entries.get(index);
    this.#store(index, entry === undefined ? undefined : mutation(entry));
  }

  start(
    index: number | undefined,
    block: Readonly<Record<string, unknown>>,
  ): void {
    const replayBlock = initialReplayBlock(block);
    const duplicate = index !== undefined && this.#entries.has(index);
    this.#store(
      index,
      duplicate || replayBlock === undefined
        ? undefined
        : { block: replayBlock, stopped: false },
    );
  }

  delta(
    index: number | undefined,
    delta: Readonly<Record<string, unknown>>,
  ): void {
    this.#update(index, (entry) => {
      const block = updatedReplayBlock(entry.block, delta);
      return block === undefined ? undefined : { ...entry, block };
    });
  }

  stop(index: number | undefined): void {
    this.#update(index, (entry) =>
      entry.stopped ? undefined : { ...entry, stopped: true },
    );
  }

  complete(index: number, block: Readonly<Record<string, unknown>>): void {
    this.start(index, block);
    this.stop(index);
  }

  finish(): AnthropicAssistantReplay | undefined {
    if (
      !this.#available ||
      this.#model === undefined ||
      [...this.#entries.values()].some(({ stopped }) => !stopped)
    ) {
      return undefined;
    }
    const blocks: AnthropicReplayBlock[] = [];
    const entries = Array.from(this.#entries.entries());
    entries.sort((left, right) => left[0] - right[0]);
    for (const [, { block }] of entries) {
      const completed = completedReplayBlock(block);
      if (!completed.valid) return undefined;
      if (completed.block !== undefined) blocks.push(completed.block);
    }
    return blocks.length === 0
      ? undefined
      : createAnthropicAssistantReplay(
          blocks,
          {
            model: this.#model,
            provenance: this.#provenance,
          },
          this.#container,
        );
  }
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

function updatedReplayBlock(
  block: MutableReplayBlock,
  delta: Readonly<Record<string, unknown>>,
): MutableReplayBlock | undefined {
  switch (delta["type"]) {
    case "text_delta":
      return block.type === "streamed_text" && typeof delta["text"] === "string"
        ? { ...block, text: block.text + delta["text"] }
        : undefined;
    case "thinking_delta":
      return block.type === "streamed_thinking" &&
        typeof delta["thinking"] === "string"
        ? { ...block, thinking: block.thinking + delta["thinking"] }
        : undefined;
    case "signature_delta":
      return block.type === "streamed_thinking" &&
        typeof delta["signature"] === "string"
        ? { ...block, signature: block.signature + delta["signature"] }
        : undefined;
    case "citations_delta":
      return appendCitation(block, delta["citation"]);
    case "input_json_delta":
      return block.type === "streamed_tool_use" &&
        typeof delta["partial_json"] === "string"
        ? { ...block, arguments: block.arguments + delta["partial_json"] }
        : block.type === "streamed_server_tool_use" &&
            typeof delta["partial_json"] === "string"
          ? appendServerToolInput(block, delta["partial_json"])
          : undefined;
    default:
      return undefined;
  }
}
