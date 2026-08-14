import {
  isAnthropicReplayObject,
  projectAnthropicReplayFields,
  readAnthropicReplayBlockType,
  type AnthropicAssistantReplay,
  type AnthropicReplayBlock,
  type AnthropicReplayObject,
} from "../shared/anthropic-replay.ts";

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
  readonly type: "tool_use";
}

type MutableReplayBlock =
  | MutableThinkingBlock
  | MutableRedactedBlock
  | MutableTextBlock
  | MutableToolBlock;

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
  if (text === undefined) return undefined;
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

function initialToolBlock(
  block: Readonly<Record<string, unknown>>,
  fields: AnthropicReplayObject,
): MutableToolBlock | undefined {
  const id = block["id"];
  const name = block["name"];
  const candidateInput = block["input"] ?? {};
  const caller = fields["caller"];
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !validToolIdentity(id, name) ||
    !isAnthropicReplayObject(candidateInput) ||
    (caller !== undefined && !isAnthropicReplayObject(caller))
  ) {
    return undefined;
  }
  return {
    arguments: "",
    ...(caller === undefined ? {} : { caller }),
    id,
    initialInput: candidateInput,
    name,
    type: "tool_use",
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
  if (type === "thinking") {
    const thinking = optionalBlockString(block["thinking"]);
    const signature = optionalBlockString(block["signature"]);
    return thinking === undefined || signature === undefined
      ? undefined
      : { signature, thinking, type };
  }
  const data = optionalBlockString(block["data"]);
  return data === undefined ? undefined : { data, type };
}

function completedToolBlock(block: MutableToolBlock): ReplayCompletion {
  let input: unknown = block.initialInput;
  if (block.arguments.length > 0) {
    try {
      input = JSON.parse(block.arguments);
    } catch {
      return { valid: false };
    }
  }
  return isAnthropicReplayObject(input)
    ? {
        block: {
          ...(block.caller === undefined ? {} : { caller: block.caller }),
          id: block.id,
          input,
          name: block.name,
          type: "tool_use",
        },
        valid: true,
      }
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
    case "text":
      return block.text.trim().length === 0
        ? { valid: true }
        : { block: { ...block }, valid: true };
    case "tool_use":
      return completedToolBlock(block);
  }
}

export class AnthropicReplayCapture {
  readonly #entries = new Map<number, ReplayEntry>();
  readonly #model: string;
  readonly #provenance: string;
  #available = true;

  constructor(model: string, provenance: string) {
    this.#model = model;
    this.#provenance = provenance;
  }

  #unavailable(): false {
    this.#available = false;
    return false;
  }

  invalidate(): void {
    this.#unavailable();
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
      : {
          blocks,
          model: this.#model,
          protocol: "anthropic",
          provenance: this.#provenance,
        };
  }
}

function appendCitation(
  block: MutableReplayBlock,
  citation: unknown,
): MutableTextBlock | undefined {
  if (block.type !== "text" || !isAnthropicReplayObject(citation)) {
    return undefined;
  }
  const citations = block.citations ?? [];
  return { ...block, citations: [...citations, citation] };
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
      return block.type === "tool_use" &&
        typeof delta["partial_json"] === "string"
        ? { ...block, arguments: block.arguments + delta["partial_json"] }
        : undefined;
    default:
      return undefined;
  }
}
