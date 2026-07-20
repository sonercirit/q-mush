import { expect, test } from "bun:test";
import { renderToHtml } from "../jsx.ts";
import type { ProviderViewState } from "../provider-client.tsx";
import type { RunnerViewState } from "../runner-client.tsx";
import {
  renderSessionPanel,
  type SessionViewState,
} from "../session-client.tsx";

const SESSION_STATE: SessionViewState = {
  sessions: [],
  stopping: false,
  sending: false,
  selectedId: undefined,
  modelDiscovery: {
    catalog: {
      defaultModel: "gpt-5-codex",
      models: [
        {
          id: "gpt-5-codex",
          label: "GPT-5 Codex (discovered)",
          reasoningEfforts: ["medium", "high", "xhigh"],
        },
      ],
    },
    credential: "openai:credential-1",
    error: undefined,
    loading: false,
  },
  loadingDetail: false,
  followUp: "",
  error: undefined,
  draft: {
    workingDirectory: ".",
    runnerId: "runner-1",
    reasoningEffort: "high",
    prompt: "",
    model: "gpt-5-codex",
    credential: "openai:credential-1",
  },
  detail: undefined,
  creating: false,
};

const RUNNER_STATE: RunnerViewState = {
  copied: false,
  creating: false,
  error: undefined,
  removingId: undefined,
  runners: [
    {
      architecture: "arm64",
      id: "runner-1",
      lastSeenAt: 1,
      name: "workstation",
      platform: "linux",
      status: "online",
    },
  ],
  setup: undefined,
};

const OPENAI_STATE: ProviderViewState = {
  credentials: [
    {
      accountId: "account-1",
      id: "credential-1",
      label: "OpenAI account",
      source: "oauth",
    },
  ],
  error: undefined,
  removingId: undefined,
  savePending: false,
};

const EMPTY_PROVIDER_STATE: ProviderViewState = {
  credentials: [],
  error: undefined,
  removingId: undefined,
  savePending: false,
};

test("renders the system prompt and model thinking in a transcript", () => {
  const state: SessionViewState = {
    ...SESSION_STATE,
    detail: {
      createdAt: 1,
      credentialId: "credential-1",
      id: "session-1",
      messages: [
        {
          content: "I should inspect the existing files first.",
          createdAt: 2,
          id: "thinking-1",
          role: "thinking",
          toolCallId: null,
          toolCalls: [],
          toolName: null,
        },
        {
          content: "",
          createdAt: 3,
          id: "assistant-1",
          role: "assistant",
          toolCallId: null,
          toolCalls: [
            {
              arguments: '{"path":"README.md","offset":1}',
              id: "call-1",
              name: "read",
            },
          ],
          toolName: null,
        },
        {
          content: "# Q Mush",
          createdAt: 4,
          id: "tool-1",
          role: "tool",
          toolCallId: "call-1",
          toolCalls: [],
          toolName: "read",
        },
      ],
      model: "gpt-5-codex",
      provider: "openai",
      reasoningEffort: "high",
      runnerId: "runner-1",
      status: "idle",
      title: "Inspect the app",
      updatedAt: 2,
      workingDirectory: ".",
    },
    selectedId: "session-1",
  };
  const html = renderToHtml(
    renderSessionPanel(state, RUNNER_STATE, OPENAI_STATE, EMPTY_PROVIDER_STATE),
  );

  expect(html).toContain("System prompt");
  expect(html).toContain(
    "You are Q Mush, a careful coding agent operating in a user-selected workspace.",
  );
  expect(html).toContain("Tool definitions");
  expect(html).toContain('"name": "read"');
  expect(html).toContain('"name": "bash"');
  expect(html).toContain('"name": "edit"');
  expect(html).toContain('"name": "write"');
  expect(html).toContain('"name": "parallel"');
  expect(html).toContain("Thinking");
  expect(html).toContain("I should inspect the existing files first.");
  expect(html).toContain("Tool call · read");
  expect(html).toContain("Tool result · read");
  expect(html).toContain("call-1");
  expect(html).toContain('{"path":"README.md","offset":1}');
  expect(html).toContain("# Q Mush");
});

test("renders model and reasoning effort as selects", () => {
  const html = renderToHtml(
    renderSessionPanel(
      SESSION_STATE,
      RUNNER_STATE,
      OPENAI_STATE,
      EMPTY_PROVIDER_STATE,
    ),
  );

  expect(html).toMatch(/<select[^>]*id="session-model"[^>]*name="model"/u);
  expect(html).not.toMatch(/<input[^>]*id="session-model"/u);
  expect(html).toContain(
    '<option selected value="gpt-5-codex">GPT-5 Codex (discovered)</option>',
  );
  expect(html).toMatch(
    /<select[^>]*id="session-reasoning-effort"[^>]*name="reasoningEffort"/u,
  );
  expect(html).toContain('<option selected value="high">High</option>');
  expect(html).toContain('<option value="xhigh">Extra high</option>');
  expect(html).not.toContain('<option value="low">Low</option>');
});
