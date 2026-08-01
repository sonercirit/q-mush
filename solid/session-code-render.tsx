import { type JSX } from "solid-js";
import {
  findJsonTextSegment,
  type JsonStreamStringToken,
  type JsonStreamToken,
  shouldRenderJsonStringAsMarkdown,
  tokenizeStreamingJson,
} from "./session-json-stream.ts";
import {
  SubscrollPane,
  subscrollPaneClasses,
} from "./session-subscroll-pane.tsx";

type RichTextRenderer = (
  content: string,
  preserveNewlines: boolean,
) => JSX.Element;

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

type SyntaxTokenKind =
  | Exclude<JsonStreamToken["kind"], undefined>
  | "comment"
  | "identifier"
  | "keyword"
  | "operator";

interface SyntaxToken {
  readonly kind: SyntaxTokenKind | undefined;
  readonly text: string;
}

const SYNTAX_TOKEN_CLASSES: Readonly<Record<SyntaxTokenKind, string>> = {
  comment: "text-slate-500 italic",
  identifier: "text-cyan-300",
  keyword: "text-fuchsia-300",
  literal: "text-violet-300",
  number: "text-amber-300",
  operator: "text-rose-300",
  property: "text-cyan-300",
  string: "text-emerald-300",
};

const CODE_BLOCK_CLASSES =
  "max-h-80 max-w-full overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-slate-950/90 p-3 pr-20 font-mono text-xs leading-5 text-slate-300";
const INLINE_CODE_CLASSES =
  "rounded bg-slate-950/80 px-1.5 py-0.5 font-mono text-[0.8em] text-cyan-200";
const RICH_JSON_STRING_CLASSES =
  "my-2 ml-2 inline-block max-w-[calc(100%-1rem)] align-top font-sans text-emerald-100 [&_code]:text-inherit";
const JAVASCRIPT_LANGUAGES = new Set([
  "cjs",
  "javascript",
  "js",
  "jsx",
  "mjs",
  "mts",
  "ts",
  "tsx",
  "typescript",
]);
const SHELL_LANGUAGES = new Set(["bash", "sh", "shell", "zsh"]);
const SOURCE_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "of",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "throw",
  "try",
  "type",
  "typeof",
  "using",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
const SOURCE_LITERALS = new Set(["false", "null", "this", "true", "undefined"]);

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function parseJson(value: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jsonPrimitiveKind(value: JsonPrimitive): SyntaxTokenKind {
  switch (typeof value) {
    case "boolean":
    case "object":
      return "literal";
    case "number":
      return "number";
    case "string":
      return "string";
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return "literal";
  }
}

function renderSyntaxToken(token: SyntaxToken): JSX.Element {
  return token.kind === undefined ? (
    token.text
  ) : (
    <span class={SYNTAX_TOKEN_CLASSES[token.kind]}>{token.text}</span>
  );
}

function renderJsonString(
  value: string,
  renderRichText: RichTextRenderer,
  complete = true,
): JSX.Element {
  if (!shouldRenderJsonStringAsMarkdown(value)) {
    return renderSyntaxToken({
      kind: "string",
      text: complete ? JSON.stringify(value) : `"${value}`,
    });
  }
  return (
    <>
      {renderSyntaxToken({ kind: "string", text: '"' })}
      <span class={RICH_JSON_STRING_CLASSES}>
        {renderRichText(value, true)}
      </span>
      {complete ? renderSyntaxToken({ kind: "string", text: '"' }) : null}
    </>
  );
}

function renderJsonPrimitive(
  value: JsonPrimitive,
  renderRichText: RichTextRenderer,
): JSX.Element {
  return typeof value === "string"
    ? renderJsonString(value, renderRichText)
    : renderSyntaxToken({
        kind: jsonPrimitiveKind(value),
        text: String(value),
      });
}

function renderJsonLines(
  value: JsonValue,
  renderRichText: RichTextRenderer,
  depth = 0,
): JSX.Element[] {
  if (value === null || typeof value !== "object") {
    return [renderJsonPrimitive(value, renderRichText)];
  }

  const entries: readonly [string | undefined, JsonValue][] = Array.isArray(
    value,
  )
    ? value.map((item) => [undefined, item])
    : Object.entries(value);
  const open = Array.isArray(value) ? "[" : "{";
  const close = Array.isArray(value) ? "]" : "}";

  if (entries.length === 0) {
    return [`${open}${close}`];
  }

  return [
    open,
    "\n",
    ...entries.flatMap(([key, item], index): JSX.Element[] => [
      "  ".repeat(depth + 1),
      ...(key === undefined
        ? []
        : [
            renderSyntaxToken({ kind: "property", text: JSON.stringify(key) }),
            ": ",
          ]),
      ...renderJsonLines(item, renderRichText, depth + 1),
      index === entries.length - 1 ? "\n" : ",\n",
    ]),
    "  ".repeat(depth),
    close,
  ];
}

function renderJsonStreamString(
  token: JsonStreamStringToken,
  renderRichText: RichTextRenderer,
): JSX.Element {
  return shouldRenderJsonStringAsMarkdown(token.value)
    ? renderJsonString(token.value, renderRichText, token.complete)
    : renderSyntaxToken(token);
}

function renderJsonTokens(
  tokens: readonly JsonStreamToken[],
  renderRichText: RichTextRenderer,
): JSX.Element[] {
  return tokens.map((token) =>
    token.kind === "string"
      ? renderJsonStreamString(token, renderRichText)
      : renderSyntaxToken(token),
  );
}

function jsonSegment(
  content: string,
  renderRichText: RichTextRenderer,
):
  | {
      readonly after: string;
      readonly before: string;
      readonly highlighted: JSX.Element[];
    }
  | undefined {
  const segment = findJsonTextSegment(content);
  if (segment === undefined) {
    return undefined;
  }
  const complete = parseJson(segment.content);
  return {
    after: segment.after,
    before: segment.before,
    highlighted:
      complete === undefined
        ? renderJsonTokens(segment.tokens, renderRichText)
        : renderJsonLines(complete, renderRichText),
  };
}

function codePane(
  content: JSX.Element,
  classes: string,
  language?: string,
): JSX.Element {
  return (
    <SubscrollPane
      label="code"
      pane={(wrapped) => (
        <pre
          class={subscrollPaneClasses(classes)}
          data-language={language}
          data-line-wrap={String(wrapped())}
        >
          {content}
        </pre>
      )}
    />
  );
}

function renderMixedJson(
  content: string,
  classes: string,
  renderRichText: RichTextRenderer,
): JSX.Element | undefined {
  const segment = jsonSegment(content, renderRichText);
  return segment === undefined
    ? undefined
    : codePane(
        <>
          {segment.before}
          <code data-language="json">{segment.highlighted}</code>
          {segment.after}
        </>,
        classes,
      );
}

function tokenizeSourceLine(line: string): readonly SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);
    const comment = /^(?:\/\/|#).*/u.exec(rest)?.[0];
    const string =
      /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/u.exec(
        rest,
      )?.[0];
    const number = /^\b(?:0[xob][\dA-Fa-f]+|\d+(?:\.\d+)?)\b/u.exec(rest)?.[0];
    const identifier = /^[A-Za-z_$][\w$]*/u.exec(rest)?.[0];
    const operator =
      /^(?:=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\+\+|--|\*\*|[+*/%=<>!&|?:~-])/u.exec(
        rest,
      )?.[0];

    if (comment !== undefined) {
      tokens.push({ kind: "comment", text: comment });
      break;
    }

    if (string !== undefined) {
      tokens.push({ kind: "string", text: string });
      index += string.length;
      continue;
    }

    if (number !== undefined) {
      tokens.push({ kind: "number", text: number });
      index += number.length;
      continue;
    }

    if (identifier !== undefined) {
      tokens.push({
        kind: SOURCE_KEYWORDS.has(identifier)
          ? "keyword"
          : SOURCE_LITERALS.has(identifier)
            ? "literal"
            : "identifier",
        text: identifier,
      });
      index += identifier.length;
      continue;
    }

    if (operator !== undefined) {
      tokens.push({ kind: "operator", text: operator });
      index += operator.length;
      continue;
    }

    const plain =
      /^[^A-Za-z_$\d'"`/# +*/%=<>!&|?:~-]+/u.exec(rest)?.[0] ?? rest[0] ?? "";
    tokens.push({ kind: undefined, text: plain });
    index += plain.length;
  }

  return tokens;
}

function highlightedSource(code: string): JSX.Element[] {
  return code
    .split("\n")
    .flatMap((line, index) => [
      ...(index === 0 ? [] : ["\n"]),
      ...tokenizeSourceLine(line).map(renderSyntaxToken),
    ]);
}

function normalizedLanguage(language: string | undefined): string | undefined {
  return language?.trim().split(/\s+/u)[0]?.toLowerCase();
}

export function renderHighlightedCodeWith(
  code: string,
  language: string | undefined,
  renderRichText: RichTextRenderer,
  classes = CODE_BLOCK_CLASSES,
): JSX.Element {
  const normalized = normalizedLanguage(language);
  const parsedJson =
    normalized === "json" || normalized === "jsonc"
      ? parseJson(code)
      : undefined;
  const streamedJson =
    parsedJson === undefined &&
    (normalized === "json" || normalized === "jsonc")
      ? tokenizeStreamingJson(code)
      : undefined;
  const highlighted =
    parsedJson !== undefined
      ? renderJsonLines(parsedJson, renderRichText)
      : streamedJson !== undefined
        ? renderJsonTokens(streamedJson, renderRichText)
        : normalized !== undefined &&
            (JAVASCRIPT_LANGUAGES.has(normalized) ||
              SHELL_LANGUAGES.has(normalized))
          ? highlightedSource(code)
          : code;

  return codePane(<code>{highlighted}</code>, classes, normalized);
}

export function renderStructuredCodeWith(
  content: string,
  renderRichText: RichTextRenderer,
  classes = CODE_BLOCK_CLASSES,
): JSX.Element {
  const json = parseJson(content);
  if (json !== undefined) {
    return codePane(
      <code>{renderJsonLines(json, renderRichText)}</code>,
      classes,
      "json",
    );
  }

  return (
    renderMixedJson(content, classes, renderRichText) ??
    codePane(content, classes)
  );
}

export function renderPlainText(text: string): JSX.Element {
  return <p class="whitespace-pre-wrap">{text}</p>;
}

export function renderStructuredTextWith(
  content: string,
  renderText: (text: string) => JSX.Element,
  renderRichText: RichTextRenderer,
): JSX.Element {
  const segment = findJsonTextSegment(content);
  if (segment === undefined) {
    return renderText(content);
  }
  return (
    <>
      {segment.before.length === 0 ? null : renderText(segment.before)}
      {renderStructuredCodeWith(segment.content, renderRichText)}
      {segment.after.length === 0 ? null : renderText(segment.after)}
    </>
  );
}

export function inlineCodeClasses(): string {
  return INLINE_CODE_CLASSES;
}
