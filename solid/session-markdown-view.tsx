import { createMemo, Index, Show, type JSX } from "solid-js";
import {
  appendMarkdownBlocks,
  normalizedMarkdownLines,
  renderMarkdownBlock,
  type MarkdownBlock,
} from "./session-markdown-render.tsx";

interface ParsedMarkdownDocument {
  readonly blocks: readonly MarkdownBlock[];
  readonly content: string;
  readonly ends: readonly number[];
  readonly lines: readonly string[];
  // Raw offset of the final normalized line: both newline forms end in
  // "\n", so the last raw "\n" starts it and appending only extends it.
  readonly rawLastLineStart: number;
  readonly starts: readonly number[];
}

function parsedMarkdownDocument(
  content: string,
  lines: readonly string[],
  blocks: readonly MarkdownBlock[],
  starts: readonly number[],
  ends: readonly number[],
): ParsedMarkdownDocument {
  return {
    blocks,
    content,
    ends,
    lines,
    rawLastLineStart: content.lastIndexOf("\n") + 1,
    starts,
  };
}

/**
 * Parses Markdown incrementally: when new content extends the previous
 * document, settled lines and blocks are reused by reference and parsing
 * resumes at the first block that can still change. Per-delta parse and
 * render work is bounded by the growing tail; the residual full-document
 * cost is one native prefix check plus pointer-level array copies.
 */
function parseMarkdownDocument(
  previous: ParsedMarkdownDocument | undefined,
  content: string,
): ParsedMarkdownDocument {
  if (previous?.content === content) return previous;
  const preserveNewlines = false;
  if (previous === undefined || !content.startsWith(previous.content)) {
    const lines = normalizedMarkdownLines(content);
    const blocks: MarkdownBlock[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    appendMarkdownBlocks(lines, 0, preserveNewlines, blocks, starts, ends);
    return parsedMarkdownDocument(content, lines, blocks, starts, ends);
  }
  // Only the previous final raw line can change, so normalize and split just
  // that line plus the appended text; earlier line strings stay shared.
  const suffixLines = normalizedMarkdownLines(
    content.slice(previous.rawLastLineStart),
  );
  const lines =
    previous.lines.length <= 1
      ? suffixLines
      : [...previous.lines.slice(0, -1), ...suffixLines];
  // A block parses identically when its scan stopped strictly before the
  // previous final line: every line its parser examined is unchanged. The
  // ends are ascending, so binary-search the first block that may change.
  const settledBefore = previous.lines.length - 1;
  let low = 0;
  let high = previous.blocks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((previous.ends[middle] ?? settledBefore) >= settledBefore) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const retained = low;
  const blocks = previous.blocks.slice(0, retained);
  const starts = previous.starts.slice(0, retained);
  const ends = previous.ends.slice(0, retained);
  // Lines between the retained blocks and the first block that may change
  // are settled blanks; resume at that block’s recorded start — or at the
  // final line when every block settled — instead of rescanning the gap.
  appendMarkdownBlocks(
    lines,
    previous.starts[retained] ?? settledBefore,
    preserveNewlines,
    blocks,
    starts,
    ends,
  );
  return parsedMarkdownDocument(content, lines, blocks, starts, ends);
}

/**
 * Reactive Markdown that re-renders only changed blocks. Settled blocks are
 * reference-stable across deltas, so their keyed rows keep both their DOM
 * and their reactive owners (wrap toggles stay live); only the growing tail
 * block re-renders.
 */
export function MarkdownView(props: { readonly content: string }): JSX.Element {
  const parsed = createMemo((previous: ParsedMarkdownDocument | undefined) =>
    parseMarkdownDocument(previous, props.content),
  );
  return (
    <div class="min-w-0 space-y-3 text-sm leading-6 text-slate-200 [overflow-wrap:anywhere]">
      <Index each={parsed().blocks}>
        {(block) => (
          <Show keyed when={block()}>
            {(value) => renderMarkdownBlock(value)}
          </Show>
        )}
      </Index>
    </div>
  );
}
