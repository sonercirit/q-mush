import { expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import type {
  ToolStreamEntry,
  ToolStreamState,
} from "../../shared/tool-stream.ts";
import { SessionTranscript } from "../../solid/session-transcript.tsx";
import { renderSolidToString } from "./render-solid.tsx";

interface TranscriptTestMessageOptions {
  readonly content: string;
  readonly id: string;
  readonly name: string;
}

function transcriptMessage(
  options: TranscriptTestMessageOptions,
  kind: "call" | "result",
): AgentSessionMessage {
  const call = kind === "call";
  return {
    content: call ? "" : options.content,
    createdAt: call ? 1 : 2,
    id: `${call ? "assistant" : "result"}-${options.id}`,
    images: [],
    role: call ? "assistant" : "tool",
    toolCallId: call ? null : options.id,
    toolCalls: call
      ? [{ arguments: options.content, id: options.id, name: options.name }]
      : [],
    toolName: call ? null : options.name,
  };
}

function assistantToolCall(options: {
  readonly arguments: string;
  readonly id: string;
  readonly name: string;
}): AgentSessionMessage {
  return transcriptMessage(
    { content: options.arguments, id: options.id, name: options.name },
    "call",
  );
}

function toolResult(
  options: TranscriptTestMessageOptions,
): AgentSessionMessage {
  return transcriptMessage(options, "result");
}

function userMessage(content: string): AgentSessionMessage {
  const message = transcriptMessage(
    { content, id: "user-1", name: "unused" },
    "result",
  );
  return {
    ...message,
    role: "user",
    toolCallId: null,
    toolName: null,
  };
}

function liveToolStream(state: ToolStreamState): ToolStreamEntry {
  return {
    arguments: '{"command":"printf ok","timeout":5}',
    callId: "live-call",
    index: 0,
    name: "bash",
    sequence: 4,
    sessionId: "session-1",
    state,
    stderr: "warning",
    stdout: "ok",
    streamId: "turn-1",
  };
}

function expectShellStreams(html: string): void {
  expect(html).toContain('aria-label="Standard output"');
  expect(html).toContain('aria-label="Standard error"');
}

function renderMessages(
  messages: readonly AgentSessionMessage[],
  tools = AGENT_SESSION_TOOL_NAMES,
): string {
  return renderSolidToString(() => (
    <SessionTranscript agentFile={null} messages={messages} tools={tools} />
  ));
}

test("renders live tools after persisted messages with separate streams", () => {
  const html = renderSolidToString(() => (
    <SessionTranscript
      agentFile={null}
      messages={[userMessage("Persisted first")]}
      toolStreams={[liveToolStream("timed-out")]}
      tools={["bash"]}
    />
  ));

  expect(html.indexOf("Persisted first")).toBeLessThan(
    html.indexOf("Live tool: bash"),
  );
  expect(html).toContain("Timed out");
  expectShellStreams(html);
});

test("shows only the session's selected tool definitions", () => {
  const html = renderMessages([], ["read", "brave_search"]);

  expect(html).toContain('"read"');
  expect(html).toContain('"brave_search"');
  expect(html).not.toContain('"bash"');
  expect(html).not.toContain('"parallel"');
});

test("preserves consecutive user message line breaks", () => {
  const html = renderMessages([
    userMessage(
      "Are we removing multi line breaks from the input?\n\n\nHow many breaks do you see in this message?",
    ),
  ]);

  expect(html).toContain(
    '<p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">Are we removing multi line breaks from the input?\n\n\nHow many breaks do you see in this message?</p>',
  );
});

test("renders persisted session errors distinctly", () => {
  const error = {
    ...userMessage("The provider connection failed"),
    id: "error-1",
    role: "error" as const,
  };
  const html = renderMessages([error]);

  expect(html).toContain("Error message");
  expect(html).toContain("The provider connection failed");
  expect(html).toContain("text-rose-200");
});

test("separates and colorizes shell output and its exit status", () => {
  const call = assistantToolCall({
    arguments: '{"command":"bun test","timeout":30}',
    id: "shell-1",
    name: "bash",
  });
  const html = renderMessages([
    call,
    toolResult({
      content: "stdout:\n1 pass\nstderr:\n1 warning\nExit code: 1",
      id: "shell-1",
      name: "bash",
    }),
  ]);

  expectShellStreams(html);
  expect(html).toContain('data-exit-status="error"');
  expect(html).toContain('<span class="text-cyan-300">stdout</span>');
  expect(html).toContain('<span class="text-rose-300">stderr</span>');
  expect(html).toContain("1 pass");
  expect(html).toContain("1 warning");
  expect(html).toContain("Exit code: 1");
});

test("uses the matching read call path to colorize file results", () => {
  const html = renderMessages([
    assistantToolCall({
      arguments: '{"path":"src/example.ts","offset":1}',
      id: "read-1",
      name: "read",
    }),
    toolResult({
      content: "const ready = true;",
      id: "read-1",
      name: "read",
    }),
  ]);

  expect(html).toContain('data-language="ts"');
  for (const token of [
    '<span class="text-fuchsia-300">const</span>',
    '<span class="text-cyan-300">ready</span>',
    '<span class="text-violet-300">true</span>',
  ]) {
    expect(html).toContain(token);
  }
});

test("renders successful edit results as a diff", () => {
  const editCall = assistantToolCall({
    arguments: JSON.stringify({
      edits: [
        {
          newText: "const ready = true;\nstart();",
          oldText: "const ready = false;\nstop();",
        },
        {
          newText: "",
          oldText: "removeMe();\n",
        },
      ],
      path: "src/example.ts",
    }),
    id: "edit-1",
    name: "edit",
  });
  const html = renderMessages([
    editCall,
    toolResult({
      content: "Successfully replaced 2 block(s) in src/example.ts.",
      id: "edit-1",
      name: "edit",
    }),
  ]);

  expect(html).toContain('aria-label="Diff for src/example.ts"');
  expect(html).toContain('data-language="diff"');
  expect(html).toContain(
    'data-diff-line="removed">-const ready = false;</span>',
  );
  expect(html).toContain('data-diff-line="removed">-stop();</span>');
  expect(html).toContain('data-diff-line="added">+const ready = true;</span>');
  expect(html).toContain('data-diff-line="added">+start();</span>');
  expect(html).toContain('data-diff-line="removed">-removeMe();</span>');
  expect(html).not.toContain('data-diff-line="removed">-</span>');
  expect(html).toContain("Successfully replaced 2 block(s) in src/example.ts.");
});

test("expands parallel results into individually formatted tool outputs", () => {
  const html = renderMessages([
    assistantToolCall({
      arguments: JSON.stringify({
        tool_uses: [
          {
            parameters: { command: "printf ok", timeout: 5 },
            recipient_name: "bash",
          },
          {
            parameters: { path: "package.json" },
            recipient_name: "read",
          },
        ],
      }),
      id: "parallel-1",
      name: "parallel",
    }),
    toolResult({
      content: JSON.stringify([
        {
          output: "stdout:\nok\nExit code: 0",
          recipient_name: "bash",
        },
        {
          output: '{"private":true}',
          recipient_name: "read",
        },
      ]),
      id: "parallel-1",
      name: "parallel",
    }),
  ]);

  expect(html).toContain("Result 1 · bash");
  expect(html).toContain("Result 2 · read");
  expect(html).toContain('data-exit-status="success"');
  expect(html).toContain('data-language="json"');
  expect(html).toContain(
    '<span class="text-cyan-300">"private"</span>: <span class="text-violet-300">true</span>',
  );
});
