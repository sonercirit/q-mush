import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import { CONFIGURED_TOOL_SETTINGS } from "../../shared/test/tool-settings-fixtures.ts";
import { formatToolLimitsStatement } from "../../shared/tool-limits.ts";
import {
  createProviderViewState,
  type ProviderCredential,
} from "../provider-credential-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import { createRunnerViewState } from "../runner-client.tsx";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { initialSessionViewState } from "../session-state.ts";
import {
  chooseTestOption,
  clickTestButton,
  disposeTestViews,
  mountTestView,
  queryTestElement,
  queryTestElementAs,
} from "./dom-test-helpers.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { sessionClientTestState } from "./session-client-test-state.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { sessionPanelResourceProps } from "./session-panel-resource-fixtures.ts";
import { selectedSessionViewState } from "./session-selected-state.ts";

const disposals: (() => void)[] = [];

function credential(
  id: string,
  label: string,
  isDefault: boolean,
): ProviderCredential {
  return {
    accountId: null,
    id,
    isDefault,
    label,
    source: "api_key",
  };
}

function isProviderDiscoveryRequest(input: RequestInfo | URL): boolean {
  if (input instanceof URL)
    return input.pathname.includes("openrouter-providers");
  const target = typeof input === "string" ? input : input.url;
  return target.includes("openrouter-providers");
}

function waitForModel(container: ParentNode, label: string): Promise<void> {
  return vi.waitFor(() => {
    expect(queryTestElement(container, "#session-model").textContent).toContain(
      label,
    );
  });
}

type TestSessionCommand = (
  operation: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

function modelDiscoveryFetch(input: RequestInfo | URL): Promise<Response> {
  return Promise.resolve(
    Response.json(isProviderDiscoveryRequest(input) ? { providers: [] } : {}),
  );
}

function mockSessionCommand(command: TestSessionCommand) {
  return vi.fn(command);
}

function createSessionTestController(
  command: TestSessionCommand,
): SessionController {
  const reactive = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    sessions: [],
  });
  return new SessionController(reactive, undefined, null, { command });
}

const PRESERVED_DRAFT = {
  credential: "openrouter:credential-2",
  model: "openrouter/selected",
  openRouterProviderTag: "q-mush-routing:price",
  reasoningEffort: "low",
  runnerId: "runner-2",
} as const;

const OPEN_AI_CREDENTIAL = credential("credential-1", "OpenAI account", true);
const SECOND_OPEN_AI_CREDENTIAL = credential(
  "credential-3",
  "OpenAI backup",
  false,
);
const OPENROUTER_CREDENTIAL = credential(
  "credential-2",
  "OpenRouter account",
  false,
);

function modelCatalog(models: AgentModelCatalog["models"]) {
  return Promise.resolve({ defaultModel: null, models });
}

function installModelDiscoveryFetch(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(modelDiscoveryFetch);
}

function testProviderStates() {
  return {
    ai: createProviderViewState([OPEN_AI_CREDENTIAL]),
    router: createProviderViewState([OPENROUTER_CREDENTIAL]),
  };
}

function createdSession(payload: Record<string, unknown>) {
  return Promise.resolve({
    ...TEST_SESSION_DETAIL,
    credentialId: String(payload["credentialId"]),
    model: String(payload["model"]),
    provider: payload["provider"] === "openrouter" ? "openrouter" : "openai",
    status: "queued",
  });
}

function mountPanel(
  controller: SessionController,
  overrides: Partial<Parameters<typeof SessionPanel>[0]> = {},
): HTMLElement {
  return mountTestView(
    () =>
      SessionPanel({
        ...sessionPanelResourceProps(controller),
        ...overrides,
      }),
    disposals,
  );
}

function mountedSessionPanel(
  command: TestSessionCommand,
  providers = testProviderStates(),
): {
  readonly container: HTMLElement;
  readonly controller: SessionController;
} {
  installModelDiscoveryFetch();
  const controller = createSessionTestController(command);
  const container = mountPanel(controller, {
    openAi: () => providers.ai,
    openRouter: () => providers.router,
  });
  return { container, controller };
}

function verifySessionCommand(
  command: ReturnType<typeof mockSessionCommand>,
  credentialId: string,
  provider: "openai" | "openrouter",
  model?: string,
): void {
  expect(command).toHaveBeenCalledWith("sessions.models", {
    credentialId,
    provider,
  });
  expect(command).toHaveBeenCalledWith(
    "sessions.create",
    expect.objectContaining({
      credentialId,
      ...(model === undefined ? {} : { model }),
      provider,
    }),
  );
}

function selectedAccountModel(payload: Record<string, unknown>) {
  const openRouter = payload["provider"] === "openrouter";
  return testAgentModelOption({
    id: openRouter ? "openrouter/model" : "openai-model",
    label: openRouter ? "OpenRouter model" : "OpenAI model",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  disposeTestViews(disposals);
});

test("shows one limits note when both session tool editors are expanded", () => {
  const reactive = createReactiveState<SessionViewState>(
    selectedSessionViewState(sessionClientTestState()),
  );
  const controller = new SessionController(reactive, undefined, null);
  const container = mountPanel(controller, {
    openAi: () => createProviderViewState([{ ...OPEN_AI_CREDENTIAL }]),
    toolSettings: () => CONFIGURED_TOOL_SETTINGS,
  });
  clickTestButton(container, "[data-tool-picker-toggle='true']");
  clickTestButton(container, "[data-session-tool-toggle='true']");

  expect(
    container.querySelectorAll("[data-tool-limits-note='true']"),
  ).toHaveLength(1);
  expect(container.textContent).toContain(
    formatToolLimitsStatement(CONFIGURED_TOOL_SETTINGS),
  );
});

test("new-session Ctrl/Cmd+Enter submits and shows the platform shortcut", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const reactive = createReactiveState<SessionViewState>(
    sessionClientTestState(),
  );
  const controller = new SessionController(reactive, undefined, null);
  const create = vi.spyOn(controller, "create").mockResolvedValue();
  controller.setDraftField("prompt", "Test the shortcut");
  const panelProps = Object.freeze({
    ...sessionPanelResourceProps(controller),
    openAi: () =>
      createProviderViewState([
        credential("credential-1", "OpenAI account", true),
      ]),
  });
  const container = mountTestView(() => SessionPanel(panelProps), disposals);
  const prompt = queryTestElementAs(
    container,
    "textarea#session-prompt",
    HTMLTextAreaElement,
  );
  const submit = queryTestElementAs(
    container,
    "button[type='submit']",
    HTMLButtonElement,
  );

  const pressShortcut = (modifier: "control" | "meta"): void => {
    const modifiers =
      modifier === "control" ? { ctrlKey: true } : { metaKey: true };
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", {
        ...modifiers,
        bubbles: true,
        key: "Enter",
      }),
    );
  };
  pressShortcut("control");
  pressShortcut("meta");

  expect(create).toHaveBeenCalledTimes(2);
  expect(submit.textContent).toBe("Start session⌘+Enter");
  expect(submit.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
  expect(submit.title).toBe("Start session (⌘+Enter)");
});

test("changing the new-session account drives model loading and creation", async () => {
  const command = mockSessionCommand((operation, payload) =>
    operation === "sessions.models"
      ? modelCatalog([selectedAccountModel(payload)])
      : createdSession(payload),
  );
  const { container, controller } = mountedSessionPanel(command);

  await waitForModel(container, "OpenAI model");
  chooseTestOption(container, "#session-credential", "openrouter:credential-2");

  await waitForModel(container, "OpenRouter model");
  controller.setDraftField("prompt", "Use the selected account");
  await controller.create();

  verifySessionCommand(
    command,
    "credential-2",
    "openrouter",
    "openrouter/model",
  );
});

test("choosing a balanced pool discovers and creates with its sentinel", async () => {
  const command = mockSessionCommand((operation, payload) => {
    if (operation !== "sessions.models") return createdSession(payload);
    return modelCatalog([
      {
        ...selectedAccountModel(payload),
        label: "Balanced OpenAI model",
      },
    ]);
  });
  const { container, controller } = mountedSessionPanel(command, {
    ai: createProviderViewState([
      OPEN_AI_CREDENTIAL,
      SECOND_OPEN_AI_CREDENTIAL,
    ]),
    router: createProviderViewState([]),
  });

  await waitForModel(container, "OpenAI model");
  chooseTestOption(container, "#session-credential", "openai:balanced:openai");
  await waitForModel(container, "Balanced OpenAI model");
  controller.setDraftField("prompt", "Balance this session");
  await controller.create();

  verifySessionCommand(command, "balanced:openai", "openai");
});

test("preserves the new-session draft across background resource updates", async () => {
  const routerModels: AgentModelCatalog["models"] = [
    {
      ...selectedAccountModel({ provider: "openrouter" }),
      id: "openrouter/primary",
      label: "OpenRouter primary",
      reasoningEfforts: ["medium", "high"],
    },
    {
      ...selectedAccountModel({ provider: "openrouter" }),
      id: "openrouter/selected",
      label: "OpenRouter selected",
      reasoningEfforts: ["low", "high"],
    },
  ];
  let routerDiscoveryCount = 0;
  const command = mockSessionCommand((operation, payload) => {
    if (operation !== "sessions.models") return Promise.resolve({});
    if (payload["provider"] !== "openrouter") {
      return modelCatalog([selectedAccountModel(payload)]);
    }
    routerDiscoveryCount += 1;
    return modelCatalog(
      routerDiscoveryCount === 1 ? routerModels : routerModels.slice(0, 1),
    );
  });
  installModelDiscoveryFetch();
  const controller = createSessionTestController(command);
  const secondRunner = {
    ...runnerSummary(2),
    id: "runner-2",
    name: "other workstation",
  };
  const providers = testProviderStates();
  const [openAi, setOpenAi] = createSignal(providers.ai);
  const [openRouter, setOpenRouter] = createSignal(providers.router);
  const [runners, setRunners] = createSignal(
    createRunnerViewState([runnerSummary(1), secondRunner]),
  );
  const container = mountTestView(
    () =>
      SessionPanel({
        controller,
        openAi,
        openRouter,
        runners,
      }),
    disposals,
  );

  await waitForModel(container, "OpenAI model");
  chooseTestOption(container, "#session-runner", "runner-2");
  chooseTestOption(container, "#session-credential", "openrouter:credential-2");
  await waitForModel(container, "OpenRouter primary");
  chooseTestOption(container, "#session-model", "openrouter/selected");
  chooseTestOption(container, "#session-reasoning-effort", "low");
  chooseTestOption(
    container,
    "#session-openrouter-provider",
    "q-mush-routing:price",
  );

  setOpenAi(createProviderViewState([{ ...OPEN_AI_CREDENTIAL }]));
  setOpenRouter(createProviderViewState([]));
  setRunners(createRunnerViewState([{ ...runnerSummary(3) }]));
  await Promise.resolve();

  expect(controller.state.draft).toMatchObject(PRESERVED_DRAFT);

  controller.retryModels();
  await vi.waitFor(() => {
    expect(routerDiscoveryCount).toBe(2);
  });

  expect(controller.state.draft).toMatchObject(PRESERVED_DRAFT);
  expect(
    queryTestElementAs(container, "input[name='model']", HTMLInputElement)
      .value,
  ).toBe("openrouter/selected");
});
