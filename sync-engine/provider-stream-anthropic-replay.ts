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
  readonly signature: string;
  readonly thinking: string;
  readonly type: "thinking";
}

interface MutableRedactedBlock {
  readonly data: string;
  readonly type: "redacted_thinking";
}

interface MutableTextBlock {
  readonly citations?: null | readonly AnthropicReplayObject[];
  readonly text: string;
  readonly type: "text";
}

interface MutableToolBlock {
  readonly arguments: string;
  readonly caller?: AnthropicReplayObject;
  readonly id: string;
  readonly initialInput: AnthropicReplayObject;
  readonly name: string;
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
  readonly caller?: AnthropicReplayObject;
  readonly id: string;
  readonly initialInput: unknown;
  readonly name: string;
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
  if (text === undefined) {
    return undefined;
  }
  if (citations === undefined || citations === null) {
    return {
      ...(citations === null ? { citations } : {}),
      text,
      type: "text",
    };
  }
  const citationObjects = replayObjectArray(citations);
  return citationObjects === undefined
    ? undefined
    : { citations: citationObjects, text, type: "text" };
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
    ...identity,
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
    ...identity,
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
      : { signature, thinking, type };
  }
  if (type === "redacted_thinking") {
    const data = optionalBlockString(block["data"]);
    return data === undefined ? undefined : { data, type };
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
  return {
    ...(block.caller === undefined ? {} : { caller: block.caller }),
    id: block.id,
    input,
    name: block.name,
  };
}

function completedToolBlock(block: MutableToolBlock): ReplayCompletion {
  const input = completedJsonInput(block.initialInput, block.arguments);
  return isAnthropicReplayObject(input)
    ? {
        block: { ...completedToolFields(block, input), type: "tool_use" },
        valid: true,
      }
    : { valid: false };
}

function completedServerToolBlock(
  block: MutableServerToolBlock,
): ReplayCompletion {
  const input = completedJsonInput(block.initialInput, block.partialInput);
  const completed = {
    ...completedToolFields(block, input),
    type: "server_tool_use" as const,
  };
  return isAnthropicReplayBlock(completed)
    ? { block: completed, valid: true }
    : { valid: false };
}

function completedStringBlock(
  block: MutableThinkingBlock | MutableRedactedBlock,
  value: string,
): ReplayCompletion {
  return value.length === 0
    ? { valid: false }
    : { block: { ...block }, valid: true };
}

function completedReplayBlock(block: MutableReplayBlock): ReplayCompletion {
  switch (block.type) {
    case "thinking":
      return completedStringBlock(block, block.signature);
    case "redacted_thinking":
      return completedStringBlock(block, block.data);
    case "text": {
      const citations = block.citations;
      // Empty text carries no assistant content; whitespace-only text does,
      // so it stays in the replay and is withheld only from requests.
      return block.text.length === 0
        ? { valid: true }
        : {
            block: {
              ...(citations === undefined ? {} : { citations }),
              text: block.text,
              type: "text",
            },
            valid: true,
          };
    }
    case "streamed_tool_use":
      return completedToolBlock(block);
    case "streamed_server_tool_use":
      return completedServerToolBlock(block);
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
  if (
    block.type !== "text" ||
    !isAnthropicReplayObject(citation) ||
    (block.citations !== undefined &&
      block.citations !== null &&
      !replayObjectArray(block.citations))
  ) {
    return undefined;
  }
  const citations = replayObjectArray(block.citations) ?? [];
  return { ...block, citations: [...citations, citation] };
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
      return block.type === "text" && typeof delta["text"] === "string"
        ? { ...block, text: block.text + delta["text"] }
        : undefined;
    case "thinking_delta":
      return block.type === "thinking" && typeof delta["thinking"] === "string"
        ? { ...block, thinking: block.thinking + delta["thinking"] }
        : undefined;
    case "signature_delta":
      return block.type === "thinking" && typeof delta["signature"] === "string"
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
