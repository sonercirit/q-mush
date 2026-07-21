import { expect, test } from "bun:test";
import { initialDirectoryPickerState } from "../directory-picker-controller.ts";
import { renderToHtml } from "../jsx.ts";
import type { ProviderViewState } from "../provider-client.tsx";
import type { RunnerViewState } from "../runner-client.tsx";
import {
  renderSessionPanel,
  type SessionViewState,
} from "../session-client.tsx";
import {
  TEST_AGENT_IMAGE,
  testUserImageMessage,
} from "./agent-image-fixtures.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import {
  FORMATTED_SESSION_MESSAGES,
  sessionStateWithMessages,
} from "./session-client-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const SESSION_STATE: SessionViewState = {
  compacting: false,
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
          inputModalities: ["text", "image", "audio"],
          label: "GPT-5 Codex (discovered)",
          outputModalities: ["text"],
          reasoningEfforts: ["medium", "high", "xhigh"],
        },
        {
          contextWindow: 64_000,
          id: "image-model",
          inputModalities: ["image"],
          label: "Image Model",
          outputModalities: ["image"],
          reasoningEfforts: [],
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
  followUpImages: [],
  error: undefined,
  draft: {
    images: [],
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
  runners: [runnerSummary(1)],
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

function renderPanel(state: SessionViewState): string {
  return renderToHtml(
    renderSessionPanel(state, RUNNER_STATE, OPENAI_STATE, EMPTY_PROVIDER_STATE),
  );
}

test("renders the system prompt and model thinking in a transcript", () => {
  const state: SessionViewState = {
    ...SESSION_STATE,
    detail: {
      agentFile: {
        content: "Always run Bun tests.",
        name: "AGENTS.md",
      },
      autoCompact: true,
      createdAt: 1,
      credentialId: "credential-1",
      currentContextTokens: 0,
      id: "session-1",
      messages: [
        {
          content: "I should inspect the existing files first.",
          createdAt: 2,
          id: "thinking-1",
          images: [],
          role: "thinking",
          toolCallId: null,
          toolCalls: [],
          toolName: null,
        },
        {
          content: "",
          createdAt: 3,
          id: "assistant-1",
          images: [],
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
          images: [],
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
  const html = renderPanel(state);

  expect(html).toContain("System prompt");
  expect(html).toContain('data-scroll-key="session-transcript:session-1"');
  expect(html).toContain('data-scroll-on-change="end"');
  expect(html).toContain('data-scroll-revision="AGENTS.md:21:3:tool-1"');
  expect(html).toContain(
    "You are Q Mush, a careful coding agent operating in a user-selected workspace.",
  );
  expect(html).toContain("Always run Bun tests.");
  expect(html).toContain('&lt;project_instructions path="AGENTS.md"&gt;');
  expect(html).not.toContain('<em class="text-slate-100 italic">instructions');
  expect(html).toContain("Agent file: AGENTS.md");
  expect(html).toContain("Context: Not reported / 200K");
  expect(html).toContain("Auto compact");
  expect(html).toContain('data-action="toggle-auto-compact"');
  expect(html).toContain('data-auto-compact="false"');
  expect(html).toContain('data-action="compact-session"');
  expect(html).toContain("Tool definitions");
  for (const toolName of ["read", "bash", "edit", "write", "parallel"]) {
    expect(html).toContain(
      `<span class="text-cyan-300">"name"</span>: <span class="text-emerald-300">"${toolName}"</span>`,
    );
  }
  expect(html).toContain("Thinking");
  expect(html).toContain("I should inspect the existing files first.");
  expect(html).toContain("Tool call · read");
  expect(html).toContain("Tool result · read");
  expect(html).toContain("call-1");
  expect(html).toContain(
    '{\n  <span class="text-cyan-300">"path"</span>: <span class="text-emerald-300">"README.md"</span>,\n  <span class="text-cyan-300">"offset"</span>: <span class="text-amber-300">1</span>\n}',
  );
  expect(html).not.toContain(
    "{&quot;path&quot;:&quot;README.md&quot;,&quot;offset&quot;:1}",
  );
  expect(html).toContain("# Q Mush");
  expect(html).toContain('data-action="continue-session"');
  expect(html).toContain(">Continue</button>");
});

test("renders image pickers, previews, and transcript images", () => {
  const state = sessionStateWithMessages(SESSION_STATE, [
    testUserImageMessage("user-image", "Use this design"),
  ]);
  const html = renderPanel({
    ...state,
    draft: { ...state.draft, images: [TEST_AGENT_IMAGE] },
    followUpImages: [TEST_AGENT_IMAGE],
  });

  expect(html).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
  expect(html).toContain('data-action="add-session-images"');
  expect(html).toContain('data-action="add-follow-up-images"');
  expect(html).toContain('data-action="remove-session-image"');
  expect(html).toContain('data-action="remove-follow-up-image"');
  expect(html).toContain(
    `src="data:image/png;base64,${TEST_AGENT_IMAGE.data}"`,
  );
  expect(html).toContain('alt="pixel.png"');
});

test("pretty prints markdown and colorizes structured transcript content", () => {
  const state = sessionStateWithMessages(
    SESSION_STATE,
    FORMATTED_SESSION_MESSAGES,
  );
  const html = renderPanel(state);

  expect(html).toContain(
    '<h2 class="text-base font-semibold text-white">Finished</h2>',
  );
  expect(html).toContain(
    '<strong class="font-semibold text-white">two files</strong>',
  );
  expect(html).toContain(
    '<code class="rounded bg-slate-950/80 px-1.5 py-0.5 font-mono text-[0.8em] text-cyan-200">bun test</code>',
  );
  expect(html).toContain('data-language="ts"');
  expect(html).toContain('<span class="text-fuchsia-300">const</span>');
  expect(html).toContain('<span class="text-cyan-300">ready</span>');
  expect(html).toContain('<span class="text-violet-300">true</span>');
  expect(html).toContain('<ul class="list-disc space-y-1 pl-5">');
  expect(html).toContain(
    '<span class="text-cyan-300">"recipient_name"</span>: <span class="text-emerald-300">"bash"</span>',
  );
  expect(html).toContain(
    '<span class="text-cyan-300">"error"</span>: <span class="text-violet-300">null</span>',
  );
  expect(html).toContain("&lt;script&gt;alert('unsafe')&lt;/script&gt;");
  expect(html).not.toContain("<script>alert");
});

test("shows context percentage and warning colors", () => {
  const renderContext = (currentContextTokens: number): string =>
    renderToHtml(
      renderSessionPanel(
        {
          ...SESSION_STATE,
          detail: {
            ...TEST_SESSION_DETAIL,
            currentContextTokens,
          },
          selectedId: TEST_SESSION_DETAIL.id,
        },
        RUNNER_STATE,
        OPENAI_STATE,
        EMPTY_PROVIDER_STATE,
      ),
    );
  const yellow = renderContext(160_000);
  const red = renderContext(180_000);

  expect(yellow).toContain("Context: 160K / 200K (80%)");
  expect(yellow).toContain("text-amber-200");
  expect(red).toContain("Context: 180K / 200K (90%)");
  expect(red).toContain("text-rose-200");
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

test("shows input and output modalities in the model select list", () => {
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
  expect(modelHtml).toMatch(
    /data-option-value="gpt-5-codex"[^>]*>[\s\S]*?All modalities · Input: Text, Image, Audio · Output: Text[\s\S]*?Supported by Q Mush · Input: Text, Image · Output: Text[\s\S]*?<\/button>/u,
  );
  expect(modelHtml).toMatch(
    /data-option-value="image-model"[^>]*>[\s\S]*?All modalities · Input: Image · Output: Image[\s\S]*?Supported by Q Mush · Input: Image · Output: None[\s\S]*?<\/button>/u,
  );
  expect(modelHtml).toContain('data-model-modalities-direction="input"');
  expect(modelHtml).toContain('data-model-modalities-direction="output"');
  expect(modelHtml).toContain("Input modalities");
  expect(modelHtml).toContain("Output modalities");
  expect(modelHtml).toContain("Text · Supported by Q Mush");
  expect(modelHtml).toContain("Image · Supported by Q Mush");
  expect(modelHtml).toContain("Audio · Not yet supported by Q Mush");
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
