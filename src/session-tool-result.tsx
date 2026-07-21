import { isRecord } from "./auth-model.ts";
import { parseOptionalJsonRecord } from "./json-record.ts";
import { createElement, type JsxNode } from "./jsx.ts";
import {
  renderHighlightedCode,
  renderStructuredCode,
} from "./session-syntax.tsx";

interface ToolCallContext {
  readonly arguments: Readonly<Record<string, unknown>> | undefined;
  readonly name: string;
}

interface EditReplacement {
  readonly newText: string;
  readonly oldText: string;
}

interface EditCall {
  readonly edits: readonly EditReplacement[];
  readonly path: string;
}

interface ParallelResult {
  readonly error: string | undefined;
  readonly output: string | undefined;
  readonly recipientName: string;
}

interface ShellOutput {
  readonly exitCode: number | undefined;
  readonly status: string;
  readonly stderr: string | undefined;
  readonly stdout: string | undefined;
}

const SOURCE_EXTENSIONS: Readonly<Record<string, string>> = {
  cjs: "js",
  css: "css",
  html: "html",
  js: "js",
  json: "json",
  jsonc: "jsonc",
  jsx: "jsx",
  md: "markdown",
  mjs: "js",
  mts: "ts",
  sh: "bash",
  ts: "ts",
  tsx: "tsx",
  yml: "yaml",
  yaml: "yaml",
  zsh: "bash",
};

function parseParallelResults(
  value: string,
): readonly ParallelResult[] | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const results = parsed.map((item): ParallelResult | undefined => {
    if (!isRecord(item) || typeof item["recipient_name"] !== "string") {
      return undefined;
    }

    const output = item["output"];
    const error = item["error"];

    if (typeof output !== "string" && typeof error !== "string") {
      return undefined;
    }

    return {
      error: typeof error === "string" ? error : undefined,
      output: typeof output === "string" ? output : undefined,
      recipientName: item["recipient_name"],
    };
  });

  return results.every((result) => result !== undefined) ? results : undefined;
}

function shellOutput(value: string): ShellOutput | undefined {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  const sections: { stderr?: string; stdout?: string } = {};
  let current: "stderr" | "stdout" | undefined;
  let exitCode: number | undefined;
  let status = "";

  for (const line of lines) {
    if (line === "stdout:" || line === "stderr:") {
      current = line === "stdout:" ? "stdout" : "stderr";
      sections[current] = "";
      continue;
    }

    const exitMatch = /^Exit code: (-?\d+)$/u.exec(line);

    if (exitMatch !== null) {
      exitCode = Number(exitMatch[1]);
      status = line;
      current = undefined;
      continue;
    }

    if (/^Timed out after \d+ seconds\.$/u.test(line)) {
      status = line;
      current = undefined;
      continue;
    }

    if (current !== undefined) {
      const existing = sections[current] ?? "";
      sections[current] =
        `${existing}${existing.length > 0 ? "\n" : ""}${line}`;
    }
  }

  if (
    sections.stdout === undefined &&
    sections.stderr === undefined &&
    status.length === 0
  ) {
    return undefined;
  }

  return {
    exitCode,
    status,
    stderr: sections.stderr,
    stdout: sections.stdout,
  };
}

function renderShellStream(options: {
  readonly content: string;
  readonly kind: "stderr" | "stdout";
}): JsxNode {
  const stderr = options.kind === "stderr";
  return (
    <section
      aria-label={stderr ? "Standard error" : "Standard output"}
      className={`overflow-hidden rounded-lg border ${stderr ? "border-rose-300/20 bg-rose-950/20" : "border-cyan-300/20 bg-cyan-950/20"}`}
    >
      <p className="border-b border-white/10 px-3 py-2 font-mono text-[0.65rem] font-semibold tracking-wider uppercase">
        <span className={stderr ? "text-rose-300" : "text-cyan-300"}>
          {options.kind}
        </span>
      </p>
      <pre className="max-h-80 overflow-auto p-3 font-mono text-xs leading-5 text-slate-300">
        {options.content.length > 0 ? options.content : "(empty)"}
      </pre>
    </section>
  );
}

function renderShellOutput(content: string): JsxNode | undefined {
  const output = shellOutput(content);

  if (output === undefined) {
    return undefined;
  }

  const success = output.exitCode === 0;
  const statusKind = success ? "success" : "error";
  return (
    <div className="space-y-2">
      {output.stdout === undefined
        ? null
        : renderShellStream({ content: output.stdout, kind: "stdout" })}
      {output.stderr === undefined
        ? null
        : renderShellStream({ content: output.stderr, kind: "stderr" })}
      {output.status.length === 0 ? null : (
        <p
          className={`rounded-lg border px-3 py-2 font-mono text-xs ${success ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-300" : "border-rose-300/20 bg-rose-300/10 text-rose-300"}`}
          data-exit-status={statusKind}
        >
          {output.status}
        </p>
      )}
    </div>
  );
}

function readPath(
  arguments_: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const path = arguments_?.["path"];
  return typeof path === "string" ? path : undefined;
}

function languageFromPath(path: string | undefined): string | undefined {
  const cleanPath = path?.split(/[?#]/u)[0];
  const fileName = cleanPath?.split(/[\\/]/u).at(-1)?.toLowerCase();

  if (fileName === undefined) {
    return undefined;
  }

  if (fileName === "dockerfile") {
    return "dockerfile";
  }

  const extension = /\.([^.]+)$/u.exec(fileName)?.[1];
  return extension === undefined ? undefined : SOURCE_EXTENSIONS[extension];
}

interface ToolOutputOptions {
  readonly arguments: Readonly<Record<string, unknown>> | undefined;
  readonly content: string;
}

function renderReadOutput(options: ToolOutputOptions): JsxNode {
  const language = languageFromPath(readPath(options.arguments));

  if (language !== undefined) {
    return renderHighlightedCode(options.content, language);
  }

  return renderStructuredCode(options.content);
}

function editCall(
  arguments_: Readonly<Record<string, unknown>> | undefined,
): EditCall | undefined {
  const path = arguments_?.["path"];
  const edits = arguments_?.["edits"];

  if (typeof path !== "string" || !Array.isArray(edits) || edits.length === 0) {
    return undefined;
  }

  const replacements = edits.map((edit): EditReplacement | undefined => {
    if (!isRecord(edit)) {
      return undefined;
    }

    const oldText = edit["oldText"];
    const newText = edit["newText"];
    return typeof oldText === "string" && typeof newText === "string"
      ? { newText, oldText }
      : undefined;
  });

  return replacements.every((edit) => edit !== undefined)
    ? { edits: replacements, path }
    : undefined;
}

function diffLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.replaceAll("\r\n", "\n").split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function renderDiffLine(content: string, kind: "added" | "removed"): JsxNode {
  const added = kind === "added";
  return (
    <span
      className={`block min-w-max px-3 ${added ? "bg-emerald-400/10 text-emerald-200" : "bg-rose-400/10 text-rose-200"}`}
      data-diff-line={kind}
    >
      {`${added ? "+" : "-"}${content}`}
    </span>
  );
}

function renderEditOutput(options: ToolOutputOptions): JsxNode | undefined {
  if (!options.content.startsWith("Successfully replaced ")) {
    return undefined;
  }

  const call = editCall(options.arguments);

  if (call === undefined) {
    return undefined;
  }

  return (
    <div className="space-y-2">
      <section
        aria-label={`Diff for ${call.path}`}
        className="overflow-hidden rounded-lg border border-white/10 bg-slate-950/90"
      >
        <p className="border-b border-white/10 px-3 py-2 font-mono text-[0.65rem] text-slate-400">
          {call.path}
        </p>
        <pre
          className="max-h-80 overflow-auto py-2 font-mono text-xs leading-5"
          data-language="diff"
        >
          <code>
            {call.edits.flatMap((edit) => [
              ...diffLines(edit.oldText).map((line) =>
                renderDiffLine(line, "removed"),
              ),
              ...diffLines(edit.newText).map((line) =>
                renderDiffLine(line, "added"),
              ),
            ])}
          </code>
        </pre>
      </section>
      <p className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 font-mono text-xs text-emerald-300">
        {options.content}
      </p>
    </div>
  );
}

function renderToolOutput(
  name: string,
  content: string,
  arguments_: Readonly<Record<string, unknown>> | undefined,
): JsxNode {
  if (name === "bash") {
    return renderShellOutput(content) ?? renderStructuredCode(content);
  }

  if (name === "edit") {
    return (
      renderEditOutput({ arguments: arguments_, content }) ??
      renderStructuredCode(content)
    );
  }

  if (name === "read") {
    return renderReadOutput({ arguments: arguments_, content });
  }

  return renderStructuredCode(content);
}

function parallelCallContexts(
  arguments_: Readonly<Record<string, unknown>> | undefined,
): readonly ToolCallContext[] {
  const toolUses = arguments_?.["tool_uses"];

  if (!Array.isArray(toolUses)) {
    return [];
  }

  return toolUses.flatMap((toolUse): readonly ToolCallContext[] => {
    if (!isRecord(toolUse) || typeof toolUse["recipient_name"] !== "string") {
      return [];
    }

    return [
      {
        arguments: isRecord(toolUse["parameters"])
          ? toolUse["parameters"]
          : undefined,
        name: toolUse["recipient_name"],
      },
    ];
  });
}

function renderParallelOutput(options: ToolOutputOptions): JsxNode | undefined {
  const results = parseParallelResults(options.content);

  if (results === undefined) {
    return undefined;
  }

  const calls = parallelCallContexts(options.arguments);
  return (
    <ol className="space-y-3">
      {results.map((result, index) => {
        const call = calls[index];
        const output = result.output;
        return (
          <li className="rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="mb-2 text-[0.65rem] font-semibold tracking-wide text-slate-400 uppercase">
              {`Result ${String(index + 1)} · ${result.recipientName}`}
            </p>
            {output === undefined ? (
              <p className="rounded-lg border border-rose-300/20 bg-rose-300/10 px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-rose-200">
                {result.error ?? "Unknown tool error"}
              </p>
            ) : (
              renderToolOutput(
                result.recipientName,
                output,
                call?.name === result.recipientName
                  ? call.arguments
                  : undefined,
              )
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function renderToolResult(options: {
  readonly arguments: string | undefined;
  readonly content: string;
  readonly name: string;
}): JsxNode {
  const arguments_ =
    options.arguments === undefined
      ? undefined
      : parseOptionalJsonRecord(options.arguments);
  return options.name === "parallel"
    ? (renderParallelOutput({
        arguments: arguments_,
        content: options.content,
      }) ?? renderStructuredCode(options.content))
    : renderToolOutput(options.name, options.content, arguments_);
}
