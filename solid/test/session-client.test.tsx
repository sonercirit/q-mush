import { expect, test } from "vitest";
import type { SessionViewState } from "../../solid/session-client.tsx";
import {
  TEST_AGENT_IMAGE,
  testUserImageMessage,
} from "./agent-image-fixtures.ts";
import { providerViewState, runnerViewState } from "./client-state-fixtures.ts";
import {
  numberedCredentials,
  numberedModels,
  numberedRunners,
} from "./custom-select-consumer-fixtures.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import {
  FORMATTED_SESSION_MESSAGES,
  sessionStateWithMessages,
} from "./session-client-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  renderSessionPanelForTest,
  renderSessionPanelWithResources,
  SESSION_PANEL_TEST_CONTEXT,
} from "./session-panel-test-context.ts";

const PANEL_CONTEXT = SESSION_PANEL_TEST_CONTEXT;
const SESSION_STATE = PANEL_CONTEXT.state;
const {
  emptyProvider: EMPTY_PROVIDER_STATE,
  openAi: OPENAI_STATE,
  runners: RUNNER_STATE,
} = PANEL_CONTEXT;

const SECOND_RUNNER_STATE = runnerViewState([
  ...(RUNNER_STATE.runners ?? []),
  {
    ...runnerSummary(2),
    id: "runner-2",
    isDefault: true,
    name: "laptop",
  },
]);

const DEFAULT_OPENAI_STATE = providerViewState([
  ...(OPENAI_STATE.credentials ?? []),
  {
    accountId: "account-2",
    id: "credential-2",
    isDefault: true,
    label: "Default OpenAI account",
    source: "api_key",
  },
]);

function stateWithoutSelections(): SessionViewState {
  return {
    ...SESSION_STATE,
    draft: {
      ...SESSION_STATE.draft,
      credential: "",
      model: "",
      reasoningEffort: "",
      runnerId: "",
    },
    modelDiscovery: {
      catalog: undefined,
      credential: undefined,
      error: undefined,
      loading: false,
    },
  };
}

function renderPanelWithProviders(
  state: SessionViewState,
  runnerState = RUNNER_STATE,
  openAiState = OPENAI_STATE,
  openRouterState = EMPTY_PROVIDER_STATE,
): string {
  const resources = [runnerState, openAiState, openRouterState] as const;
  return renderSessionPanelWithResources(PANEL_CONTEXT, state, ...resources);
}

function renderPanel(state: SessionViewState): string {
  return renderSessionPanelForTest(PANEL_CONTEXT, state);
}

test("paginates every session select consumer without provider-specific behavior", () => {
  const runners = numberedRunners();
  const credentials = numberedCredentials();
  const openAiCredentials = credentials.slice(0, 6);
  const openRouterCredentials = credentials.slice(6);
  const models = numberedModels();
  const baseState = {
    ...SESSION_STATE,
    draft: {
      ...SESSION_STATE.draft,
      credential: "openrouter:credential-12",
      model: "model-12",
      runnerId: "runner-12",
    },
    modelDiscovery: {
      catalog: { defaultModel: "model-1", models },
      credential: "openrouter:credential-12",
      error: undefined,
      loading: false,
    },
  };
  const states: readonly SessionViewState[] = [
    { ...baseState, openSelect: "runnerId" },
    { ...baseState, openSelect: "credential" },
    { ...baseState, openSelect: "model" },
  ];
  const html = states.map((state) =>
    renderPanelWithProviders(
      state,
      runnerViewState(runners),
      providerViewState(openAiCredentials),
      providerViewState(openRouterCredentials),
    ),
  );

  for (const [index, name] of ["runnerId", "credential", "model"].entries()) {
    expect(html[index]).toContain(`data-custom-select-search="${name}"`);
    expect(html[index]).toContain(`data-custom-select-page="${name}"`);
  }
  const credentialHtml = html[1] ?? "";
  expect(credentialHtml).toContain(
    'data-option-value="openrouter:credential-12"',
  );
  expect(credentialHtml).toContain("OpenRouter · Credential 12");
  const modelHtml = html[2] ?? "";
  expect(modelHtml).toContain('data-option-value="model-12"');
  expect(modelHtml).not.toContain('data-option-value="model-1"');
  expect(modelHtml).toContain("Text, Image");
  expect(modelHtml).toContain("12K context");
});

test("keeps editable session controls in the reactive tree", () => {
  const newSessionHtml = renderPanel(SESSION_STATE);
  const followUpHtml = renderPanel(
    sessionStateWithMessages(SESSION_STATE, FORMATTED_SESSION_MESSAGES),
  );

  expect(newSessionHtml).toContain('id="session-directory"');
  expect(newSessionHtml).toContain('id="session-prompt"');
  expect(newSessionHtml).toContain("Tools &amp; skills");
  expect(newSessionHtml).toContain('name="tools"');
  expect(newSessionHtml).toContain("Brave Search");
  expect(followUpHtml).toContain('name="prompt"');
  expect(newSessionHtml).not.toContain("data-focus-key");
  expect(followUpHtml).not.toContain("data-focus-key");
});

test("shows session time and cost in the list and detail", () => {
  const session = {
    ...TEST_SESSION_DETAIL,
    activeDurationMs: 65_000,
    activeStartedAt: null,
    costBasis: "estimated" as const,
    costUsd: 0.0042,
  };
  const html = renderPanel({
    ...SESSION_STATE,
    detail: session,
    selectedId: session.id,
    sessions: [session],
  });

  expect(html.match(/Time: 1m 5s/gu)).toHaveLength(2);
  expect(html.match(/Estimated cost: \$0\.0042/gu)).toHaveLength(2);
});

test("renders the session list as a scrollable region", () => {
  const html = renderPanel({
    ...SESSION_STATE,
    sessions: [TEST_SESSION_DETAIL],
  });

  expect(html).toMatch(/<ul class="[^"]*max-h-144[^"]*overflow-y-auto[^"]*"/u);
  expect(html).not.toContain("data-scroll-key");
});

test("renders independently filtered session instructions and activity", () => {
  const state: SessionViewState = {
    ...SESSION_STATE,
    detail: {
      ...TEST_SESSION_DETAIL,
      agentFile: {
        content: "Always run Bun tests.",
        name: "AGENTS.md",
      },
      autoCompact: true,
      createdAt: 1,
      credentialId: "credential-1",
      currentContextTokens: 0,
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
      providerPricing: null,
      reasoningEffort: "high",
      runnerId: "runner-1",
      status: "idle",
      title: "Inspect the app",
      updatedAt: 2,
      workingDirectory: ".",
    },
    selectedId: "session-1",
    transcriptFilters: {
      ...SESSION_STATE.transcriptFilters,
      agentInstructions: true,
      systemPrompt: true,
      thinking: true,
      toolDefinitions: true,
    },
  };
  const html = renderPanel(state);

  expect(html).toContain('aria-label="Transcript visibility"');
  for (const category of [
    "Base instructions",
    "Stored agent instructions",
    "Selected tool definitions",
    "Tool calls and responses",
    "User messages",
    "Thinking and reasoning",
    "Assistant messages",
    "Errors and session notices",
  ]) {
    expect(html).toContain(category);
  }
  expect(html).toContain("System prompt");
  expect(html).not.toContain("data-scroll-key");
  expect(html).not.toContain("data-scroll-on-change");
  expect(html).not.toContain("data-scroll-revision");
  expect(html).toContain(
    "You are Q Mush, a careful coding agent operating in a user-selected workspace.",
  );
  expect(html).toContain("Always run Bun tests.");
  expect(html).not.toContain('&lt;project_instructions path="AGENTS.md">');
  expect(html).not.toContain('<em class="text-slate-100 italic">instructions');
  expect(html).toContain("Agent file: AGENTS.md");
  expect(html).toContain("Context: Not reported / 200K");
  expect(html).toContain("Auto compact");
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
    '<span class="text-cyan-300">"path"</span>: <span class="text-emerald-300">"README.md"</span>',
  );
  expect(html).toContain(
    '<span class="text-cyan-300">"offset"</span>: <span class="text-amber-300">1</span>',
  );
  expect(html).not.toContain(
    "{&quot;path&quot;:&quot;README.md&quot;,&quot;offset&quot;:1}",
  );
  expect(html).toContain("# Q Mush");
  expect(html).toContain(">Continue without message</button>");
});

test("renders active queue actions, exact shortcut hints, and pending input order", () => {
  const html = renderPanel({
    ...SESSION_STATE,
    detail: {
      ...TEST_SESSION_DETAIL,
      pendingInputs: [
        {
          content: "Wait for the current task",
          createdAt: 3,
          id: "pending-follow",
          images: [TEST_AGENT_IMAGE],
          kind: "follow_up",
        },
        {
          content: "Use a smaller change",
          createdAt: 4,
          id: "pending-steer",
          images: [],
          kind: "steer",
        },
      ],
      status: "running",
    },
    selectedId: TEST_SESSION_DETAIL.id,
  });

  expect(html).toContain("Follow up");
  expect(html).toContain("Steer");
  expect(html).toContain("Ctrl+Enter");
  expect(html).toContain("Ctrl+Shift+Enter");
  expect(html.indexOf("Queued follow up")).toBeLessThan(
    html.indexOf("Queued steer"),
  );
  expect(html).toContain("Wait for the current task");
  expect(html).toContain("Use a smaller change");
  expect(html).not.toContain(">Continue without message</button>");
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
  expect(html).toContain("&lt;script>alert('unsafe')&lt;/script>");
  expect(html).not.toContain("<script>alert");
});

test("shows context percentage and warning colors", () => {
  const renderContext = (currentContextTokens: number): string =>
    renderPanel({
      ...SESSION_STATE,
      detail: {
        ...TEST_SESSION_DETAIL,
        currentContextTokens,
      },
      selectedId: TEST_SESSION_DETAIL.id,
    });
  const yellow = renderContext(160_000);
  const red = renderContext(180_000);

  expect(yellow).toContain("Context: 160K / 200K (80%)");
  expect(yellow).toContain("text-amber-200");
  expect(red).toContain("Context: 180K / 200K (90%)");
  expect(red).toContain("text-rose-200");
});

test("renders a directory browser beside the working-directory input", () => {
  const closedHtml = renderPanel(SESSION_STATE);

  expect(closedHtml).toMatch(
    /<input[^>]*id="session-directory"[^>]*name="workingDirectory"/u,
  );
  expect(closedHtml).toContain(">Browse</button>");
  expect(closedHtml).not.toContain('data-directory-picker="true"');
  expect(closedHtml).not.toContain(" inert");

  const defaultRunnerHtml = renderPanel({
    ...SESSION_STATE,
    draft: { ...SESSION_STATE.draft, runnerId: "" },
  });
  const browseControl = /<button[^>]*>Browse<\/button>/u.exec(
    defaultRunnerHtml,
  )?.[0];
  expect(browseControl).not.toMatch(/\sdisabled(?:\s|>)/u);

  const openHtml = renderPanel({
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
  });

  expect(openHtml).toContain('aria-modal="true"');
  expect(openHtml).toContain('data-directory-picker="true"');
  expect(openHtml).toContain('tabindex="-1"');
  expect(openHtml).toMatch(/<section[^>]*\sinert(?:\s|>)/u);
  expect(openHtml).toContain("Choose a working directory");
  expect(openHtml).toContain("/home/mush/projects");
  expect(openHtml).toContain(
    'data-directory-path="/home/mush/projects/mush room"',
  );
  expect(openHtml).toContain(">mush room</span>");
  expect(openHtml).toContain("Choose this directory");
});

test("defaults runner and credential choices to the first entries", () => {
  const html = renderPanel(stateWithoutSelections());

  expect(html).toMatch(
    /data-custom-select="runnerId"[\s\S]*?<input name="runnerId" required type="hidden" value="runner-1">/u,
  );
  expect(html).toMatch(
    /data-custom-select="credential"[\s\S]*?<input name="credential" required type="hidden" value="openai:credential-1">/u,
  );
  expect(html).not.toContain("Choose a runner");
  expect(html).not.toContain("Choose a model credential");
});

test("defers the credential fallback until both providers settle", () => {
  const loadingProvider = providerViewState(undefined);
  const unsettledHtml = renderPanelWithProviders(
    stateWithoutSelections(),
    RUNNER_STATE,
    OPENAI_STATE,
    loadingProvider,
  );

  expect(unsettledHtml).toMatch(
    /data-custom-select="credential"[\s\S]*?<input name="credential" required type="hidden" value="">/u,
  );
  expect(unsettledHtml).toContain('data-credentials-settled="false"');

  const openRouterDefault = providerViewState([
    {
      accountId: "router-account",
      id: "router-default",
      isDefault: true,
      label: "Default OpenRouter account",
      source: "oauth",
    },
  ]);
  const settledHtml = renderPanelWithProviders(
    stateWithoutSelections(),
    RUNNER_STATE,
    OPENAI_STATE,
    openRouterDefault,
  );

  expect(settledHtml).toMatch(
    /data-custom-select="credential"[\s\S]*?<input name="credential" required type="hidden" value="openrouter:router-default">/u,
  );
  expect(settledHtml).toContain('data-credentials-settled="true"');
});

test("selects marked runner and credential defaults", () => {
  const html = renderPanelWithProviders(
    stateWithoutSelections(),
    SECOND_RUNNER_STATE,
    DEFAULT_OPENAI_STATE,
  );

  expect(html).toMatch(
    /data-custom-select="runnerId"[\s\S]*?<input name="runnerId" required type="hidden" value="runner-2">/u,
  );
  expect(html).toMatch(
    /data-custom-select="credential"[\s\S]*?<input name="credential" required type="hidden" value="openai:credential-2">/u,
  );
});

test("defaults the model control to the provider's first option", () => {
  const catalog = SESSION_STATE.modelDiscovery.catalog;

  if (catalog === undefined) {
    throw new Error("The test model catalog is missing");
  }

  const html = renderPanel({
    ...SESSION_STATE,
    draft: { ...SESSION_STATE.draft, model: "", reasoningEffort: "" },
    modelDiscovery: {
      ...SESSION_STATE.modelDiscovery,
      catalog: { ...catalog, defaultModel: "image-model" },
    },
  });

  expect(html).toMatch(
    /data-custom-select="model"[\s\S]*?<input name="model" required type="hidden" value="gpt-5-codex"/u,
  );
});

test("shows input and output modalities in the model select list", () => {
  const modelHtml = renderPanel(SESSION_STATE);

  expect(modelHtml).toContain('data-custom-select="runnerId"');
  expect(modelHtml).toContain('data-custom-select="credential"');
  expect(modelHtml).not.toMatch(/<select/u);
  expect(modelHtml).toContain('data-custom-select="model"');
  expect(modelHtml).not.toMatch(/<select[^>]*id="session-model"/u);
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

  const reasoningHtml = renderPanel({
    ...SESSION_STATE,
    openSelect: "reasoningEffort",
  });
  expect(reasoningHtml).toContain('data-option-value="high"');
  expect(reasoningHtml).toContain("Extra high");
  expect(reasoningHtml).not.toContain('data-option-value="low"');
});
