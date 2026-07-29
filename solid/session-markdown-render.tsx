import { For, type JSX } from "solid-js";
import {
  inlineCodeClasses,
  renderHighlightedCodeWith,
  renderPlainText,
  renderStructuredTextWith,
} from "./session-code-render.tsx";

interface MarkdownCodeBlock {
  readonly code: string;
  readonly language: string | undefined;
  readonly type: "code";
}

interface MarkdownHeadingBlock {
  readonly level: number;
  readonly text: string;
  readonly type: "heading";
}

interface MarkdownListBlock {
  readonly items: readonly MarkdownListItem[];
  readonly ordered: boolean;
  readonly start: number;
  readonly type: "list";
}

interface MarkdownListItem {
  readonly checked: boolean | undefined;
  readonly text: string;
}

interface MarkdownTableBlock {
  readonly alignments: readonly MarkdownTableAlignment[];
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly type: "table";
}

type MarkdownTableAlignment = "center" | "left" | "right";

interface MarkdownParagraphBlock {
  readonly text: string;
  readonly type: "paragraph";
}

interface MarkdownPreservedBlock {
  readonly text: string;
  readonly type: "preserved";
}

interface MarkdownRawBlock {
  readonly text: string;
  readonly type: "raw";
}

interface MarkdownRuleBlock {
  readonly text: "";
  readonly type: "rule";
}

interface MarkdownQuoteBlock {
  readonly text: string;
  readonly type: "quote";
}

type MarkdownBlock =
  | MarkdownCodeBlock
  | MarkdownHeadingBlock
  | MarkdownListBlock
  | MarkdownParagraphBlock
  | MarkdownPreservedBlock
  | MarkdownQuoteBlock
  | MarkdownRawBlock
  | MarkdownRuleBlock
  | MarkdownTableBlock;

interface ParsedBlock {
  readonly block: MarkdownBlock;
  readonly nextIndex: number;
}

interface InlineRender {
  readonly end: number;
  readonly node: JSX.Element;
}

const URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function findClosingMarker(text: string, marker: string, from: number): number {
  const index = text.indexOf(marker, from);
  return index > from ? index : -1;
}

function safeLink(href: string): string | undefined {
  try {
    const url = new URL(href, "https://q-mush.invalid");
    return URL_PROTOCOLS.has(url.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

function closingInline(
  text: string,
  marker: string,
  index: number,
  createNode: (content: string) => JSX.Element,
): InlineRender | undefined {
  const end = findClosingMarker(text, marker, index + marker.length);
  return end < 0
    ? undefined
    : {
        end: end + marker.length,
        node: createNode(text.slice(index + marker.length, end)),
      };
}

function inlineAt(text: string, index: number): InlineRender | undefined {
  return text[index] === "["
    ? linkInline(text, index)
    : markedInline(text, index);
}

function markedInline(text: string, index: number): InlineRender | undefined {
  if (text[index] === "`" && text[index + 1] !== "`") {
    return closingInline(text, "`", index, (content) => (
      <code class={inlineCodeClasses()}>{content}</code>
    ));
  }

  const marker = text.startsWith("**", index)
    ? "**"
    : text.startsWith("__", index)
      ? "__"
      : text.startsWith("~~", index)
        ? "~~"
        : undefined;

  if (marker !== undefined) {
    return closingInline(text, marker, index, (content) => {
      const children = renderInline(content);
      return marker === "~~" ? (
        <del class="text-slate-400">{children}</del>
      ) : (
        <strong class="font-semibold text-white">{children}</strong>
      );
    });
  }

  if (text[index] === "*" || text[index] === "_") {
    const inlineMarker = text[index] ?? "";
    return closingInline(text, inlineMarker, index, (content) => (
      <em class="text-slate-100 italic">{renderInline(content)}</em>
    ));
  }

  return undefined;
}

function linkInline(text: string, index: number): InlineRender | undefined {
  const labelEnd = text.indexOf("](", index + 1);
  const hrefEnd = labelEnd < 0 ? -1 : text.indexOf(")", labelEnd + 2);

  if (labelEnd <= index + 1 || hrefEnd <= labelEnd + 2) {
    return undefined;
  }

  const href = safeLink(text.slice(labelEnd + 2, hrefEnd));

  if (href === undefined) {
    return undefined;
  }

  return {
    end: hrefEnd + 1,
    node: (
      <a
        class="text-cyan-300 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-200"
        href={href}
        rel="noreferrer noopener"
        target="_blank"
      >
        {renderInline(text.slice(index + 1, labelEnd))}
      </a>
    ),
  };
}

function renderInline(text: string): JSX.Element[] {
  const nodes: JSX.Element[] = [];
  let plain = "";
  let index = 0;
  const flush = () => {
    if (plain.length > 0) {
      nodes.push(plain);
      plain = "";
    }
  };

  while (index < text.length) {
    const formatted = inlineAt(text, index);

    if (formatted === undefined) {
      plain += text[index] ?? "";
      index += 1;
      continue;
    }

    flush();
    nodes.push(formatted.node);
    index = formatted.end;
  }

  flush();
  return nodes;
}

function splitTableRow(line: string): readonly string[] | undefined {
  let content = line.trim();
  let hasPipe = false;

  if (content.startsWith("|")) {
    content = content.slice(1);
    hasPipe = true;
  }
  if (/(?<!\\)(?:\\\\)*\|$/u.test(content)) {
    content = content.slice(0, -1);
    hasPipe = true;
  }

  const cells: string[] = [];
  let cell = "";

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";

    if (character === "\\" && content[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      hasPipe = true;
    } else {
      cell += character;
    }
  }

  cells.push(cell.trim());
  return hasPipe ? cells : undefined;
}

function tableAlignment(cell: string): MarkdownTableAlignment | undefined {
  const match = /^(:?)(-+)(:?)$/u.exec(cell);
  if (
    match === null ||
    ((match[1] === "" || match[3] === "") && (match[2]?.length ?? 0) < 3)
  ) {
    return undefined;
  }
  if (match[1] === ":") {
    return match[3] === ":" ? "center" : "left";
  }
  return match[3] === ":" ? "right" : "left";
}

function markdownTable(
  lines: readonly string[],
  startIndex: number,
): ParsedBlock | undefined {
  const header = splitTableRow(lines[startIndex] ?? "");
  const separator = splitTableRow(lines[startIndex + 1] ?? "");

  if (
    header === undefined ||
    separator === undefined ||
    header.length < 2 ||
    separator.length !== header.length
  ) {
    return undefined;
  }

  const alignments: MarkdownTableAlignment[] = [];
  for (const cell of separator) {
    const alignment = tableAlignment(cell);
    if (alignment === undefined) {
      return undefined;
    }
    alignments.push(alignment);
  }

  const rows: string[][] = [];
  let nextIndex = startIndex + 2;
  for (; nextIndex < lines.length; nextIndex += 1) {
    const line = lines[nextIndex] ?? "";
    if (line.trim().length === 0) {
      break;
    }
    const row = splitTableRow(line);
    if (row === undefined) {
      break;
    }
    rows.push([...row]);
  }

  return {
    block: {
      alignments,
      header,
      rows,
      type: "table",
    },
    nextIndex,
  };
}

function paragraphText(lines: readonly string[]): string {
  return lines.map((line) => line.trim()).join(" ");
}

function markdownList(
  lines: readonly string[],
  startIndex: number,
  firstMatch: RegExpExecArray,
): ParsedBlock {
  const ordered = firstMatch[1] !== undefined;
  const items: MarkdownListItem[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const match = /^\s*(?:(\d+)[.)]|[-+*])\s+(?:\[([ xX])\]\s+)?(.+)$/u.exec(
      lines[index] ?? "",
    );

    if (match === null || (match[1] !== undefined) !== ordered) {
      break;
    }

    items.push({
      checked:
        match[2] === undefined ? undefined : match[2].toLowerCase() === "x",
      text: match[3] ?? "",
    });
    index += 1;
  }

  return {
    block: {
      items,
      ordered,
      start: Number(firstMatch[1] ?? 1),
      type: "list",
    },
    nextIndex: index,
  };
}

function markdownCode(
  lines: readonly string[],
  startIndex: number,
  fence: RegExpExecArray,
): ParsedBlock {
  const marker = fence[1] ?? "```";
  const code: string[] = [];
  let index = startIndex + 1;

  while (
    index < lines.length &&
    !(lines[index] ?? "").trimStart().startsWith(marker)
  ) {
    code.push(lines[index] ?? "");
    index += 1;
  }

  return {
    block: {
      code: code.join("\n"),
      language:
        fence[2] === undefined || fence[2].trim().length === 0
          ? undefined
          : fence[2].trim(),
      type: "code",
    },
    nextIndex: index < lines.length ? index + 1 : index,
  };
}

function isRawTranscriptLine(line: string): boolean {
  return /^(?:<[A-Za-z/][^>]*>|\[[A-Za-z0-9_.-]+\]|stdout:|stderr:|Exit code:)/u.test(
    line.trim(),
  );
}

function beginsBlock(line: string): boolean {
  return (
    /^\s*(`{3,}|~{3,})/u.test(line) ||
    /^\s{0,3}#{1,6}\s+/u.test(line) ||
    /^\s*(?:(?:\d+)[.)]|[-+*])\s+/u.test(line) ||
    /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/u.test(line) ||
    /^\s*>\s?/u.test(line)
  );
}

function appendParagraphLines(
  lines: readonly string[],
  startIndex: number,
  preserveWhitespace: boolean,
): { readonly nextIndex: number; readonly text: string } {
  const content = [lines[startIndex] ?? ""];
  let index = startIndex + 1;

  while (
    index < lines.length &&
    (lines[index] ?? "").trim().length > 0 &&
    !beginsBlock(lines[index] ?? "")
  ) {
    content.push(lines[index] ?? "");
    index += 1;
  }

  return {
    nextIndex: index,
    text: preserveWhitespace ? content.join("\n") : paragraphText(content),
  };
}

function parseSpecialBlock(
  lines: readonly string[],
  index: number,
  line: string,
): ParsedBlock | undefined {
  const fence = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);

  if (fence !== null) {
    return markdownCode(lines, index, fence);
  }

  const listItem = /^\s*(?:(\d+)[.)]|[-+*])\s+(?:\[([ xX])\]\s+)?(.+)$/u.exec(
    line,
  );
  return listItem === null ? undefined : markdownList(lines, index, listItem);
}

function parseMarkdownBlocks(
  content: string,
  preserveNewlines = false,
): readonly MarkdownBlock[] {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const table = markdownTable(lines, index);

    if (table !== undefined) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const special = parseSpecialBlock(lines, index, line);

    if (special !== undefined) {
      blocks.push(special.block);
      index = special.nextIndex;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);

    if (heading !== null) {
      blocks.push({
        level: heading[1]?.length ?? 1,
        text: heading[2] ?? "",
        type: "heading",
      });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/u.test(line)) {
      const quote: string[] = [];

      while (index < lines.length && /^\s*>\s?/u.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s?/u, ""));
        index += 1;
      }

      blocks.push({ text: paragraphText(quote), type: "quote" });
      continue;
    }

    if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/u.test(line)) {
      blocks.push({ text: "", type: "rule" });
      index += 1;
      continue;
    }

    const raw = isRawTranscriptLine(line);
    const parsed = appendParagraphLines(lines, index, preserveNewlines || raw);
    blocks.push({
      text: parsed.text,
      type: raw ? "raw" : preserveNewlines ? "preserved" : "paragraph",
    });
    index = parsed.nextIndex;
  }

  return blocks;
}

function headingClasses(level: number): string {
  switch (level) {
    case 1:
      return "text-lg font-semibold text-white";
    case 2:
      return "text-base font-semibold text-white";
    case 3:
      return "text-sm font-semibold text-white";
    case 4:
    case 5:
    case 6:
    default:
      return "text-sm font-medium text-slate-100";
  }
}

function renderMarkdownList(block: MarkdownListBlock): JSX.Element {
  const children = block.items.map((item) => (
    <li>
      {item.checked === undefined ? null : (
        <span
          aria-hidden="true"
          class={item.checked ? "text-emerald-300" : "text-slate-500"}
        >
          {item.checked ? "☑ " : "☐ "}
        </span>
      )}
      {renderInline(item.text)}
    </li>
  ));

  return block.ordered ? (
    <ol class="list-decimal space-y-1 pl-5" start={block.start}>
      {children}
    </ol>
  ) : (
    <ul class="list-disc space-y-1 pl-5">{children}</ul>
  );
}

function tableCellClasses(
  alignment: MarkdownTableAlignment,
  header: boolean,
): string {
  const textAlignment =
    alignment === "center"
      ? "text-center"
      : alignment === "right"
        ? "text-right"
        : "text-left";
  return header
    ? `px-3 py-2 ${textAlignment} font-semibold text-slate-100`
    : `border-t border-white/10 px-3 py-2 ${textAlignment} align-top`;
}

function renderMarkdownTable(block: MarkdownTableBlock): JSX.Element {
  return (
    <div class="overflow-x-auto rounded-lg border border-white/10">
      <table class="w-full border-collapse text-sm">
        <thead class="bg-white/5">
          <tr>
            <For each={block.header}>
              {(cell, index) => (
                <th
                  class={tableCellClasses(
                    block.alignments[index()] ?? "left",
                    true,
                  )}
                  scope="col"
                >
                  {renderInline(cell)}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={block.rows}>
            {(row) => (
              <tr>
                <For each={block.header}>
                  {(_, index) => (
                    <td
                      class={tableCellClasses(
                        block.alignments[index()] ?? "left",
                        false,
                      )}
                    >
                      {renderInline(row[index()] ?? "")}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

function renderMarkdownBlock(block: MarkdownBlock): JSX.Element {
  switch (block.type) {
    case "code":
      return renderHighlightedCodeWith(
        block.code,
        block.language,
        renderMarkdown,
      );
    case "heading":
      return (
        <h2 class={headingClasses(block.level)}>{renderInline(block.text)}</h2>
      );
    case "list":
      return renderMarkdownList(block);
    case "paragraph":
      return renderStructuredTextWith(
        block.text,
        (text) => <p>{renderInline(text)}</p>,
        renderMarkdown,
      );
    case "preserved":
      return <p class="whitespace-pre-wrap">{renderInline(block.text)}</p>;
    case "quote":
      return (
        <blockquote class="border-l-2 border-cyan-300/40 pl-3 text-slate-400 italic">
          {renderInline(block.text)}
        </blockquote>
      );
    case "raw":
      return renderStructuredTextWith(
        block.text,
        renderPlainText,
        renderMarkdown,
      );
    case "rule":
      return <hr class="border-white/10" />;
    case "table":
      return renderMarkdownTable(block);
  }
}

export function renderMarkdown(
  content: string,
  preserveNewlines = false,
): JSX.Element {
  return (
    <div class="min-w-0 space-y-3 text-sm leading-6 text-slate-200 [overflow-wrap:anywhere]">
      {parseMarkdownBlocks(content, preserveNewlines).map(renderMarkdownBlock)}
    </div>
  );
}
