type JsonStreamTokenKind = "literal" | "number" | "property" | "string";

export interface JsonStreamStringToken {
  readonly complete: boolean;
  readonly kind: "string";
  readonly text: string;
  readonly value: string;
}

interface JsonStreamPlainToken {
  readonly kind: Exclude<JsonStreamTokenKind, "string"> | undefined;
  readonly text: string;
}

export type JsonStreamToken = JsonStreamPlainToken | JsonStreamStringToken;

export interface JsonTextSegment {
  readonly after: string;
  readonly before: string;
  readonly content: string;
  readonly tokens: readonly JsonStreamToken[];
}

type ArrayState = "comma_or_end" | "value_or_end";
type ObjectState = "colon" | "comma_or_end" | "key_or_end" | "value";

interface ArrayContext {
  itemCount: number;
  readonly kind: "array";
  state: ArrayState;
}

interface ObjectContext {
  itemCount: number;
  readonly kind: "object";
  state: ObjectState;
}

type JsonContext = ArrayContext | ObjectContext;

interface StringToken {
  readonly complete: boolean;
  readonly end: number;
  readonly value: string;
}

interface ConsumedToken {
  readonly complete: boolean;
  readonly end: number;
}

const COMPLETE_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const PARTIAL_NUMBER = /^-?(?:(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?)?$/u;
const MARKDOWN_STRING_CONTENT =
  /(?:^|\n)\s*(?:#{1,6}\s|>|(?:\d+[.)]|[-+*])\s|`{3,}|~{3,})|(?:\*\*|__|~~|`[^`\n]+`|\[[^\]\n]+\]\([^\n)]+\))/u;
const MAXIMUM_JSON_SEGMENT_CANDIDATES = 64;

export function shouldRenderJsonStringAsMarkdown(value: string): boolean {
  return /[\r\n]/u.test(value) || MARKDOWN_STRING_CONTENT.test(value);
}

function lineStart(content: string, index: number): boolean {
  const newline = content.lastIndexOf("\n", index - 1);
  return /^\s*$/u.test(content.slice(newline + 1, index));
}

function rootEnd(content: string, start: number): number | undefined {
  const stack: string[] = [content[start] === "{" ? "}" : "]"];
  let escaped = false;
  let inString = false;

  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (character === undefined) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character === "{" ? "}" : "]");
      continue;
    }
    if (character === "}" || character === "]") {
      if (stack.at(-1) !== character) {
        return undefined;
      }
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }

  return content.length;
}

function parsedString(text: string): string | undefined {
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "string" ? parsed : undefined;
}

function readString(content: string, start: number): StringToken | undefined {
  let index = start + 1;
  while (index < content.length) {
    const character = content[index];
    if (character === '"') {
      const text = content.slice(start, index + 1);
      return {
        complete: true,
        end: index + 1,
        value: parsedString(text) ?? "",
      };
    }
    if (character === undefined || character.charCodeAt(0) < 0x20) {
      return undefined;
    }
    if (character !== "\\") {
      index += 1;
      continue;
    }

    index += 1;
    const escape = content[index];
    if (escape === undefined) {
      return incompleteToken(content, start);
    }
    if (escape !== "u") {
      if (!/^["\\/bfnrt]$/u.test(escape)) {
        return undefined;
      }
      index += 1;
      continue;
    }

    index += 1;
    for (let digit = 0; digit < 4; digit += 1) {
      const hexadecimal = content[index];
      if (hexadecimal === undefined) {
        return incompleteToken(content, start);
      }
      if (!/^[\dA-Fa-f]$/u.test(hexadecimal)) {
        return undefined;
      }
      index += 1;
    }
  }

  return incompleteToken(content, start);
}

function incompleteToken(content: string, start: number): StringToken {
  const encoded = content.slice(start + 1);
  let decoded: string | undefined;
  try {
    decoded = parsedString(`"${encoded}"`);
  } catch {
    decoded = undefined;
  }
  return {
    complete: false,
    end: content.length,
    value: decoded ?? encoded,
  };
}

function literalAt(content: string, index: number): ConsumedToken | undefined {
  for (const literal of ["false", "null", "true"] as const) {
    if (content.startsWith(literal, index)) {
      return { complete: true, end: index + literal.length };
    }
    const remaining = content.slice(index);
    if (literal.startsWith(remaining)) {
      return { complete: false, end: content.length };
    }
  }
  return undefined;
}

function appendToken(
  tokens: JsonStreamToken[],
  text: string,
  kind: Exclude<JsonStreamTokenKind, "string"> | undefined,
): void {
  const previous = tokens.at(-1);
  if (
    kind === undefined &&
    previous !== undefined &&
    previous.kind === undefined
  ) {
    tokens[tokens.length - 1] = { kind: undefined, text: previous.text + text };
  } else {
    tokens.push({ kind, text });
  }
}

function appendStringToken(
  tokens: JsonStreamToken[],
  content: string,
  start: number,
  string: StringToken,
): void {
  tokens.push({
    complete: string.complete,
    kind: "string",
    text: content.slice(start, string.end),
    value: string.value,
  });
}

function beginItem(
  tokens: JsonStreamToken[],
  context: JsonContext,
  depth: number,
): void {
  appendToken(tokens, `\n${"  ".repeat(depth)}`, undefined);
  context.itemCount += 1;
}

function closeContext(
  tokens: JsonStreamToken[],
  stack: JsonContext[],
  character: "}" | "]",
): boolean {
  const context = stack.at(-1);
  if (
    context === undefined ||
    (character === "}" && context.kind !== "object") ||
    (character === "]" && context.kind !== "array")
  ) {
    return false;
  }
  if (context.itemCount > 0) {
    appendToken(tokens, `\n${"  ".repeat(stack.length - 1)}`, undefined);
  }
  appendToken(tokens, character, undefined);
  stack.pop();
  return true;
}

function consumeNumber(
  content: string,
  index: number,
): ConsumedToken | undefined {
  let end = index;
  while (/^[-+\d.eE]$/u.test(content[end] ?? "")) {
    end += 1;
  }
  const text = content.slice(index, end);
  if (!PARTIAL_NUMBER.test(text)) {
    return undefined;
  }
  const complete = COMPLETE_NUMBER.test(text);
  return complete || end === content.length ? { complete, end } : undefined;
}

function markValueConsumed(context: JsonContext): void {
  context.state = "comma_or_end";
}

function nestedContext(character: "{" | "["): JsonContext {
  return character === "{"
    ? { itemCount: 0, kind: "object", state: "key_or_end" }
    : { itemCount: 0, kind: "array", state: "value_or_end" };
}

function consumeValue(
  content: string,
  index: number,
  context: JsonContext,
  stack: JsonContext[],
  tokens: JsonStreamToken[],
): number | undefined {
  const character = content[index];
  markValueConsumed(context);
  if (character === "{" || character === "[") {
    appendToken(tokens, character, undefined);
    stack.push(nestedContext(character));
    return index + 1;
  }
  if (character === '"') {
    const string = readString(content, index);
    if (string === undefined) {
      return undefined;
    }
    appendStringToken(tokens, content, index, string);
    return string.complete || string.end === content.length
      ? string.end
      : undefined;
  }
  if (character === "-" || /^\d$/u.test(character ?? "")) {
    const number = consumeNumber(content, index);
    if (number === undefined) {
      return undefined;
    }
    appendToken(tokens, content.slice(index, number.end), "number");
    return number.end;
  }
  const literal = literalAt(content, index);
  if (literal === undefined) {
    return undefined;
  }
  appendToken(tokens, content.slice(index, literal.end), "literal");
  return literal.end;
}

export function tokenizeStreamingJson(
  content: string,
): readonly JsonStreamToken[] | undefined {
  const first = content[0];
  if (first !== "{" && first !== "[") {
    return undefined;
  }

  const tokens: JsonStreamToken[] = [{ kind: undefined, text: first }];
  const stack: JsonContext[] = [nestedContext(first)];
  let index = 1;

  while (index < content.length) {
    if (/^\s$/u.test(content[index] ?? "")) {
      index += 1;
      continue;
    }
    const context = stack.at(-1);
    if (context === undefined) {
      return undefined;
    }
    const character = content[index];
    const emptyClose =
      context.kind === "object" && context.state === "key_or_end"
        ? "}"
        : context.kind === "array" && context.state === "value_or_end"
          ? "]"
          : undefined;
    if (emptyClose !== undefined && character === emptyClose) {
      if (!closeContext(tokens, stack, emptyClose)) {
        return undefined;
      }
      index += 1;
      continue;
    }

    if (context.kind === "object") {
      if (context.state === "key_or_end") {
        if (character !== '"') {
          return undefined;
        }
        beginItem(tokens, context, stack.length);
        const property = readString(content, index);
        if (property === undefined) {
          return undefined;
        }
        appendToken(tokens, content.slice(index, property.end), "property");

        index = property.end;
        context.state = "colon";
        if (!property.complete) {
          return index === content.length ? tokens : undefined;
        }
        continue;
      }
      if (context.state === "colon") {
        if (character !== ":") {
          return undefined;
        }
        appendToken(tokens, ": ", undefined);
        context.state = "value";
        index += 1;
        continue;
      }
      if (context.state === "value") {
        const next = consumeValue(content, index, context, stack, tokens);
        if (next === undefined) {
          return undefined;
        }
        index = next;
        continue;
      }
    } else if (context.state === "value_or_end") {
      beginItem(tokens, context, stack.length);
      index = consumeValue(content, index, context, stack, tokens) ?? -1;
      if (index < 0) {
        return undefined;
      }
      continue;
    }

    if (character === ",") {
      appendToken(tokens, character, undefined);
      context.state = context.kind === "object" ? "key_or_end" : "value_or_end";
      index += 1;
      continue;
    }
    const expectedClose = context.kind === "object" ? "}" : "]";
    if (
      character !== expectedClose ||
      !closeContext(tokens, stack, character)
    ) {
      return undefined;
    }
    index += 1;
  }

  return tokens;
}

export function findJsonTextSegment(
  content: string,
): JsonTextSegment | undefined {
  const firstNonWhitespace = content.search(/\S/u);
  const lastNonWhitespace = content.search(/\s*$/u);
  let candidateCount = 0;

  for (let start = 0; start < content.length; start += 1) {
    const character = content[start];
    if (character !== "{" && character !== "[") {
      continue;
    }
    candidateCount += 1;
    if (candidateCount > MAXIMUM_JSON_SEGMENT_CANDIDATES) {
      return undefined;
    }
    const end = rootEnd(content, start);
    if (end === undefined) {
      continue;
    }
    const atContentEdge =
      start === firstNonWhitespace || end === lastNonWhitespace;
    if (!atContentEdge && !lineStart(content, start)) {
      continue;
    }
    const segmentContent = content.slice(start, end);
    const tokens = tokenizeStreamingJson(segmentContent);
    if (tokens !== undefined) {
      return {
        after: content.slice(end),
        before: content.slice(0, start),
        content: segmentContent,
        tokens,
      };
    }
  }

  return undefined;
}
