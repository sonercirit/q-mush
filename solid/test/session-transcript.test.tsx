import { expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import {
  DEFAULT_SESSION_TRANSCRIPT_FILTERS,
  type SessionTranscriptFilters,
} from "../../solid/session-transcript-filters.ts";
import {
  assistantToolCall,
  message,
  renderMessages,
  toolResult,
  userMessage,
} from "./session-transcript-test-helpers.tsx";

function filtersWith(
  category: keyof SessionTranscriptFilters,
): SessionTranscriptFilters {
  return {
    agentInstructions: false,
    assistantMessages: false,
    notices: false,
    systemPrompt: false,
    thinking: false,
    toolActivity: false,
    toolDefinitions: false,
    userMessages: false,
    [category]: true,
  };
}

test.each([
  ["systemPrompt", "System prompt", "You are Q Mush"],
  ["agentInstructions", "AGENTS.md", "Project rule"],
  ["toolDefinitions", "Tool definitions", '"read"'],
  ["userMessages", "User category", "User category"],
  ["thinking", "Thinking category", "Thinking category"],
  ["assistantMessages", "Assistant category", "Assistant category"],
  ["notices", "Notice category", "Notice category"],
] as const)(
  "renders only the selected %s transcript category",
  (category, expectedLabel, expectedContent) => {
    const html = renderMessages(
      [
        message("user-category", "User category", "user"),
        message("thinking-category", "Thinking category", "thinking"),
        message("assistant-category", "Assistant category", "assistant"),
        message("notice-category", "Notice category", "error"),
      ],
      ["read"],
      filtersWith(category),
      { content: "Project rule", name: "AGENTS.md" },
    );

    expect(html).toContain(expectedLabel);
    expect(html).toContain(expectedContent);
    for (const hidden of [
      "User category",
      "Thinking category",
      "Assistant category",
      "Notice category",
    ]) {
      if (hidden !== expectedContent) {
        expect(html).not.toContain(hidden);
      }
    }
  },
);

test("keeps tool calls and matching responses in one filter category", () => {
  const call = assistantToolCall({
    arguments: '{"path":"README.md"}',
    id: "read-category",
    name: "read",
  });
  const result = toolResult({
    content: "Tool category result",
    id: "read-category",
    name: "read",
  });
  const visible = renderMessages(
    [call, result],
    ["read"],
    filtersWith("toolActivity"),
  );
  const hidden = renderMessages(
    [call, result],
    ["read"],
    filtersWith("assistantMessages"),
  );

  expect(visible).toContain("Tool call · read");
  expect(visible).toContain("Tool result · read");
  expect(visible).toContain("Tool category result");
  expect(hidden).not.toContain("Tool call · read");
  expect(hidden).not.toContain("Tool result · read");
  expect(hidden).not.toContain(
    'data-render-boundary="message:assistant-read-category"',
  );
  expect(hidden).toContain(
    "No transcript items match the current visibility filters.",
  );
});

test("filters assistant text independently from tool calls on the same message", () => {
  const call = {
    ...assistantToolCall({
      arguments: '{"path":"README.md"}',
      id: "read-category",
      name: "read",
    }),
    content: "Assistant text with tool",
  };
  const toolOnly = renderMessages(
    [call],
    ["read"],
    filtersWith("toolActivity"),
  );
  const assistantOnly = renderMessages(
    [call],
    ["read"],
    filtersWith("assistantMessages"),
  );

  expect(toolOnly).toContain("Tool call · read");
  expect(toolOnly).not.toContain("Assistant text with tool");
  expect(assistantOnly).toContain("Assistant text with tool");
  expect(assistantOnly).not.toContain("Tool call · read");
});

test("shows a clear state when every visible category is empty", () => {
  const emptyAgentInstructions = renderMessages([], [], {
    ...filtersWith("agentInstructions"),
  });
  const emptyToolDefinitions = renderMessages(
    [],
    [],
    filtersWith("toolDefinitions"),
  );

  for (const html of [emptyAgentInstructions, emptyToolDefinitions]) {
    expect(html).toContain(
      "No transcript items match the current visibility filters.",
    );
  }
  expect(emptyToolDefinitions).not.toContain("Show selected tool schemas");
});

test("preserves canonical order among visible transcript categories", () => {
  const html = renderMessages(
    [
      message("user-order", "First visible", "user"),
      message("thinking-order", "Hidden middle", "thinking"),
      message("assistant-order", "Second visible", "assistant"),
      message("notice-order", "Third visible", "system"),
    ],
    [],
    {
      ...DEFAULT_SESSION_TRANSCRIPT_FILTERS,
      systemPrompt: false,
      thinking: false,
      toolDefinitions: false,
    },
  );

  expect(html.indexOf("First visible")).toBeLessThan(
    html.indexOf("Second visible"),
  );
  expect(html.indexOf("Second visible")).toBeLessThan(
    html.indexOf("Third visible"),
  );
  expect(html).not.toContain("Hidden middle");
});

test("shows only the session's selected tool definitions", () => {
  const html = renderMessages([], ["read", "brave_search"]);

  expect(html).toContain('"read"');
  expect(html).toContain('"brave_search"');
  expect(html).not.toContain('"bash"');
  expect(html).not.toContain('"parallel"');
});

function renderForkMessages(messages: readonly AgentSessionMessage[]): string {
  return renderMessages(
    messages,
    [],
    DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    null,
    () => undefined,
  );
}

test("renders fork controls only for natural conversation fork points", () => {
  const html = renderForkMessages([
    message("user-fork", "Request", "user"),
    message("thinking-fork", "Reasoning", "thinking"),
    message("assistant-fork", "Response", "assistant"),
    message("tool-fork", "Result", "tool"),
    message("system-fork", "Notice", "system"),
  ]);

  expect(html).toContain('data-fork-from-here="user-fork"');
  expect(html).toContain('data-fork-from-here="assistant-fork"');
  expect(html.match(/Fork from here<\/button>/gu)).toHaveLength(2);
  for (const id of ["thinking-fork", "tool-fork", "system-fork"]) {
    expect(html).not.toContain(`data-fork-from-here="${id}"`);
  }
});

test("renders the compaction request before its streamed response", () => {
  const html = renderMessages([
    message(
      "stream:compaction-step:compaction-request",
      "Compact this conversation into a handoff.",
      "compaction_request",
    ),
    message("stream:session-1:assistant", "Summary in progress", "assistant"),
  ]);

  expect(html).toContain("Compaction request");
  expect(
    html.indexOf("Compact this conversation into a handoff."),
  ).toBeLessThan(html.indexOf("Summary in progress"));
});

test("does not offer fork controls for streamed messages", () => {
  const streamedId = "stream:session-1:assistant";
  const html = renderForkMessages([
    message(streamedId, "Partial response", "assistant"),
  ]);

  expect(html).not.toContain(`data-fork-from-here="${streamedId}"`);
  expect(html).not.toContain("Fork from here");
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

  expect(html).toContain('aria-label="Standard output"');
  expect(html).toContain('aria-label="Standard error"');
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
  expect(html).toContain('data-diff-line-number="1"');
  expect(html).toContain('data-diff-line-number="5"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("select-none");
  expect(html).toContain('data-diff-line="removed"><span aria-hidden="true"');
  expect(html).toContain(">1</span><span class=");
  expect(html).toContain(">-const ready = false;</span>");
  expect(html).toContain(">2</span><span class=");
  expect(html).toContain(">-stop();</span>");
  expect(html).toContain(">3</span><span class=");
  expect(html).toContain(">+const ready = true;</span>");
  expect(html).toContain(">4</span><span class=");
  expect(html).toContain(">+start();</span>");
  expect(html).toContain(">5</span><span class=");
  expect(html).toContain(">-removeMe();</span>");
  expect(html).not.toContain(">6</span>");
  expect(html).not.toContain(">-</span>");
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
