import { isRecord } from "../shared/auth-model.ts";
import {
  codePointPrefix,
  toolOutputTruncationNotice,
  unicodeCharacterCount,
} from "../shared/tool-output-limits.ts";

export type StructuredSessionToolName =
  "get_session_options" | "list_sessions" | "parallel" | "read_session";

type MutableRecord = Record<string, unknown>;

export function isStructuredSessionToolName(
  value: string | undefined,
): value is StructuredSessionToolName {
  return (
    value === "get_session_options" ||
    value === "list_sessions" ||
    value === "parallel" ||
    value === "read_session"
  );
}

function mutableRecord(value: unknown): MutableRecord | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function parseObject(output: string): MutableRecord | undefined {
  try {
    const value: unknown = JSON.parse(output);
    return mutableRecord(value);
  } catch {
    return undefined;
  }
}

function compact(value: unknown): string {
  return JSON.stringify(value);
}

function serializedWithinMaximum(
  serialize: () => string,
  maximum: number,
): string | undefined {
  const output = serialize();
  return unicodeCharacterCount(output) <= maximum ? output : undefined;
}

function shrinkStringToFit(options: {
  readonly field: string;
  readonly maximum: number;
  readonly record: MutableRecord;
  readonly serialize: () => string;
}): boolean {
  const original = options.record[options.field];
  if (typeof original !== "string" || original.length === 0) return false;
  let lower = 0;
  let upper = unicodeCharacterCount(original);
  let selected = "";
  options.record[options.field] = selected;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = codePointPrefix(original, middle);
    options.record[options.field] = candidate;
    if (unicodeCharacterCount(options.serialize()) <= options.maximum) {
      selected = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  options.record[options.field] = selected;
  return selected !== original;
}

function serializeAfterRemovingOversizedItems(options: {
  readonly envelope: MutableRecord;
  readonly items: unknown[];
  readonly maximum: number;
  readonly sourceLength?: number;
  readonly truncation?: MutableRecord;
}): string | undefined {
  const serialize = (): string => compact(options.envelope);
  while (
    unicodeCharacterCount(serialize()) > options.maximum &&
    options.items.length > 0
  ) {
    options.items.pop();
    options.envelope["returnedItems"] = options.items.length;
    if (options.sourceLength === undefined) {
      if (options.truncation !== undefined) {
        options.truncation["items"] = true;
      }
    } else {
      options.envelope["omittedItems"] =
        options.sourceLength - options.items.length;
    }
  }
  return serializedWithinMaximum(serialize, options.maximum);
}

function boundedReadSessionOutput(
  parsed: MutableRecord,
  maximum: number,
): string | undefined {
  const sourceContent = mutableRecord(parsed["content"]);
  const sourceMetadata = mutableRecord(parsed["metadata"]);
  const session = mutableRecord(parsed["session"]);
  if (
    sourceContent === undefined ||
    sourceMetadata === undefined ||
    session === undefined
  ) {
    return undefined;
  }
  const records = Array.isArray(sourceContent["records"])
    ? sourceContent["records"].map((record: unknown) => record)
    : undefined;
  if (records === undefined) return undefined;
  const definitions = Array.isArray(sourceContent["toolDefinitions"])
    ? sourceContent["toolDefinitions"].map((definition: unknown) => definition)
    : undefined;
  const content: MutableRecord = {
    ...sourceContent,
    records,
    ...(definitions === undefined ? {} : { toolDefinitions: definitions }),
  };
  const sourceTruncation = mutableRecord(sourceMetadata["truncation"]);
  const truncation: MutableRecord = {
    ...(sourceTruncation ?? {}),
    outputCharacters: true,
    records: sourceTruncation?.["records"] === true,
    systemPrompt: sourceTruncation?.["systemPrompt"] === true,
    toolDefinitions: sourceTruncation?.["toolDefinitions"] === true,
  };
  const toolDefinitions = mutableRecord(sourceMetadata["toolDefinitions"]);
  const metadata: MutableRecord = {
    ...sourceMetadata,
    notice: toolOutputTruncationNotice(maximum),
    truncated: true,
    truncation,
    ...(toolDefinitions === undefined ? {} : { toolDefinitions }),
  };
  const envelope: MutableRecord = { ...parsed, content, metadata, session };
  const serialize = (): string => compact(envelope);
  const refreshCounts = (): void => {
    metadata["returnedRecords"] = records.length;
    if (toolDefinitions !== undefined) {
      toolDefinitions["returned"] = definitions?.length ?? 0;
    }
  };
  refreshCounts();
  while (unicodeCharacterCount(serialize()) > maximum && records.length > 1) {
    records.shift();
    truncation["records"] = true;
    refreshCounts();
  }
  while (
    unicodeCharacterCount(serialize()) > maximum &&
    definitions !== undefined &&
    definitions.length > 0
  ) {
    definitions.pop();
    truncation["toolDefinitions"] = true;
    refreshCounts();
  }
  if (
    unicodeCharacterCount(serialize()) > maximum &&
    shrinkStringToFit({
      field: "systemPrompt",
      maximum,
      record: content,
      serialize,
    })
  ) {
    truncation["systemPrompt"] = true;
  }
  const newestRecord = mutableRecord(records.at(-1));
  if (
    unicodeCharacterCount(serialize()) > maximum &&
    newestRecord !== undefined
  ) {
    records[records.length - 1] = newestRecord;
    if (
      shrinkStringToFit({
        field: "content",
        maximum,
        record: newestRecord,
        serialize,
      })
    ) {
      truncation["records"] = true;
    }
    if (
      unicodeCharacterCount(serialize()) > maximum &&
      Array.isArray(newestRecord["toolCalls"]) &&
      newestRecord["toolCalls"].length > 0
    ) {
      newestRecord["toolCalls"] = [];
      truncation["records"] = true;
    }
  }
  const remaining = records.length;
  if (unicodeCharacterCount(serialize()) > maximum && remaining > 0) {
    records.splice(0, remaining);
    truncation["records"] = true;
    refreshCounts();
  }
  return serializedWithinMaximum(serialize, maximum);
}

function boundedPaginatedOutput(
  parsed: MutableRecord,
  maximum: number,
): string | undefined {
  if (!Array.isArray(parsed["items"])) return undefined;
  const items = parsed["items"].map((item: unknown) => item);
  const sourceTruncation = mutableRecord(parsed["truncation"]);
  const truncation: MutableRecord = {
    ...(sourceTruncation ?? {}),
    items: false,
    outputCharacters: true,
  };
  const envelope: MutableRecord = {
    ...parsed,
    items,
    notice: toolOutputTruncationNotice(maximum),
    returnedItems: items.length,
    truncated: true,
    truncation,
  };
  return serializeAfterRemovingOversizedItems({
    envelope,
    items,
    maximum,
    truncation,
  });
}

function boundedParallelOutput(
  parsed: MutableRecord | unknown[],
  maximum: number,
): string | undefined {
  const sourceItems: unknown[] | undefined = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed["items"])
      ? parsed["items"]
      : undefined;
  if (sourceItems === undefined) return undefined;
  const items = [...sourceItems];
  const envelope: MutableRecord = {
    items,
    notice: toolOutputTruncationNotice(maximum),
    omittedItems: 0,
    returnedItems: items.length,
    totalItems: sourceItems.length,
    truncated: true,
  };
  return serializeAfterRemovingOversizedItems({
    envelope,
    items,
    maximum,
    sourceLength: sourceItems.length,
  });
}

export function boundStructuredSessionToolOutput(
  output: string,
  maximum: number,
  tool: StructuredSessionToolName,
): string | undefined {
  if (unicodeCharacterCount(output) <= maximum) return output;
  if (tool === "parallel") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return undefined;
    }
    return Array.isArray(parsed) || isRecord(parsed)
      ? boundedParallelOutput(parsed, maximum)
      : undefined;
  }
  const parsed = parseObject(output);
  if (parsed === undefined) return undefined;
  return tool === "read_session"
    ? boundedReadSessionOutput(parsed, maximum)
    : boundedPaginatedOutput(parsed, maximum);
}
