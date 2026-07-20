import { expect, test } from "bun:test";
import { initialDirectoryPickerState } from "../directory-picker-controller.ts";
import { renderToHtml } from "../jsx.ts";
import type { ProviderViewState } from "../provider-client.tsx";
import type { RunnerViewState } from "../runner-client.tsx";
import {
  renderSessionPanel,
  type SessionViewState,
} from "../session-client.tsx";

const SESSION_STATE: SessionViewState = {
  directoryPicker: initialDirectoryPickerState(),
  sessions: [],
  stopping: false,
  sending: false,
  selectedId: undefined,
  modelDiscovery: {
    catalog: {
      defaultModel: "gpt-5-codex",
      models: [
        {
          contextWindow: 200_000,
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
  openSelect: "model",
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
      agentFile: {
        content: "Always run Bun tests.",
        name: "AGENTS.md",
      },
      createdAt: 1,
      credentialId: "credential-1",
      currentContextTokens: 0,
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
      maxContextTokens: 200_000,
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
  expect(html).toContain('data-scroll-key="session-transcript:session-1"');
  expect(html).toContain('data-scroll-on-change="end"');
  expect(html).toContain('data-scroll-revision="AGENTS.md:21:3:tool-1"');
  expect(html).toContain(
    "You are Q Mush, a careful coding agent operating in a user-selected workspace.",
  );
  expect(html).toContain("Always run Bun tests.");
  expect(html).toContain("Agent file: AGENTS.md");
  expect(html).toContain("Context: Not reported / 200K");
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

test("renders a directory browser beside the working-directory input", () => {
  const closedHtml = renderToHtml(
    renderSessionPanel(
      SESSION_STATE,
      RUNNER_STATE,
      OPENAI_STATE,
      EMPTY_PROVIDER_STATE,
    ),
  );

  expect(closedHtml).toMatch(
    /<input[^>]*id="session-directory"[^>]*name="workingDirectory"/u,
  );
  expect(closedHtml).toContain('data-action="open-directory-picker"');
  expect(closedHtml).toContain(">Browse</button>");
  expect(closedHtml).not.toContain('data-directory-picker="true"');
  expect(closedHtml).not.toContain(" inert");

  const defaultRunnerHtml = renderToHtml(
    renderSessionPanel(
      {
        ...SESSION_STATE,
        draft: { ...SESSION_STATE.draft, runnerId: "" },
      },
      RUNNER_STATE,
      OPENAI_STATE,
      EMPTY_PROVIDER_STATE,
    ),
  );
  const browseControl =
    /<button[^>]*data-action="open-directory-picker"[^>]*>/u.exec(
      defaultRunnerHtml,
    )?.[0];
  expect(browseControl).not.toMatch(/\sdisabled(?:\s|>)/u);

  const openHtml = renderToHtml(
    renderSessionPanel(
      {
        ...SESSION_STATE,
        directoryPicker: {
          error: undefined,
          listing: {
            directories: [
              {
                name: "mush room",
                path: "/home/mush/projects/mush room",
              },
            ],
            parent: "/home/mush",
            path: "/home/mush/projects",
            truncated: false,
          },
          loading: false,
          open: true,
          requestedPath: ".",
          runnerId: "runner-1",
        },
      },
      RUNNER_STATE,
      OPENAI_STATE,
      EMPTY_PROVIDER_STATE,
    ),
  );

  expect(openHtml).toContain('aria-modal="true"');
  expect(openHtml).toContain('data-directory-picker="true"');
  expect(openHtml).toContain('tabindex="-1"');
  expect(openHtml).toContain("<section inert");
  expect(openHtml).toContain("Choose a working directory");
  expect(openHtml).toContain("/home/mush/projects");
  expect(openHtml).toContain('data-action="browse-parent-directory"');
  expect(openHtml).toContain('data-action="browse-home-directory"');
  expect(openHtml).toContain('data-action="browse-directory"');
  expect(openHtml).toContain(
    'data-directory-path="/home/mush/projects/mush room"',
  );
  expect(openHtml).toContain(">mush room</span>");
  expect(openHtml).toContain('data-action="choose-directory"');
  expect(openHtml).toContain("Choose this directory");
  expect(openHtml).toContain('data-action="close-directory-picker"');
});

test("renders custom model and reasoning selectors with context limits", () => {
  const modelHtml = renderToHtml(
    renderSessionPanel(
      SESSION_STATE,
      RUNNER_STATE,
      OPENAI_STATE,
      EMPTY_PROVIDER_STATE,
    ),
  );

  expect(modelHtml).toContain('data-custom-select="runnerId"');
  expect(modelHtml).toContain('data-custom-select="credential"');
  expect(modelHtml).not.toMatch(/<select/u);
  expect(modelHtml).toContain('data-custom-select="model"');
  expect(modelHtml).not.toMatch(/<select[^>]*id="session-model"/u);
  expect(modelHtml).toContain('data-action="toggle-session-select"');
  expect(modelHtml).toContain('data-action="choose-session-option"');
  expect(modelHtml).toContain('data-option-value="gpt-5-codex"');
  expect(modelHtml).toContain("GPT-5 Codex (discovered)");
  expect(modelHtml).toContain("200K context");
  expect(modelHtml).toContain('data-custom-select="reasoningEffort"');
  expect(modelHtml).not.toMatch(/<select[^>]*id="session-reasoning-effort"/u);

  const reasoningHtml = renderToHtml(
    renderSessionPanel(
      { ...SESSION_STATE, openSelect: "reasoningEffort" },
      RUNNER_STATE,
      OPENAI_STATE,
      EMPTY_PROVIDER_STATE,
    ),
  );
  expect(reasoningHtml).toContain('data-option-value="high"');
  expect(reasoningHtml).toContain("Extra high");
  expect(reasoningHtml).not.toContain('data-option-value="low"');
});
