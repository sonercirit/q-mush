import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AgentModelCatalog,
  OpenRouterProviderCatalog,
} from "../../shared/agent-configuration.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SESSION_PROVIDER_CACHE_WARNING } from "../../shared/session-provider-update.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import { SessionProviderUpdateEditor } from "../session-provider-update-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import {
  chooseTestOption,
  clickTestButton,
  expectTestText,
  mountTestView,
  queryTestElementAs,
  setTestInputValue,
} from "./dom-test-helpers.ts";
import { testSessionCredentialOption } from "./session-credential-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const RETAINED_CAP_ERROR =
  "Lower or clear the context token cap before changing models.";

function invalidContextCapError(): Error & { readonly code: string } {
  class InvalidContextCapError extends Error {
    readonly code = "invalid_context_token_cap";
  }
  return new InvalidContextCapError(RETAINED_CAP_ERROR);
}

function modelCredential(
  detail: Pick<AgentSessionDetail, "credentialId" | "provider">,
  label = "Session credential",
) {
  return {
    id: detail.credentialId,
    label,
    provider: detail.provider,
  };
}

function modelCatalogDiscovery(): Promise<AgentModelCatalog> {
  return Promise.resolve(MODEL_CATALOG);
}

function providerDiscovery() {
  return Promise.resolve({ providers: [] });
}

async function submitProviderChange(container: ParentNode): Promise<void> {
  clickTestButton(container, "[data-session-provider-toggle='true']");
  await vi.waitFor(() => {
    expect(
      queryTestElementAs(
        container,
        "[data-session-provider-update-submit='true']",
        HTMLButtonElement,
      ).disabled,
    ).toBe(false);
  });
  clickTestButton(container, "[data-session-provider-update-submit='true']");
  clickTestButton(container, "[data-session-provider-update-confirm='true']");
}

const MODEL_CATALOG = testAgentModelCatalog({
  contextWindow: 64_000,
  id: "model-2",
  label: "Model 2",
});

const TOGETHER_PROVIDER: OpenRouterProviderCatalog["providers"][number] = {
  contextWindow: 64_000,
  name: "Together",
  pricing: null,
  tag: "together",
};
const OPENROUTER_PROVIDER_CATALOG: OpenRouterProviderCatalog = {
  providers: [TOGETHER_PROVIDER],
};
const OPENROUTER_DETAIL: AgentSessionDetail = {
  ...TEST_SESSION_DETAIL,
  model: "model-2",
  openRouterProviderTag: "together",
  provider: "openrouter",
};

let disposeView: (() => void) | undefined;

function mount(
  renderView: Parameters<typeof mountTestView>[0],
): HTMLDivElement {
  const viewDisposals: (() => void)[] = [];
  const container = mountTestView(renderView, viewDisposals);
  disposeView = viewDisposals[0];
  return container;
}

function ProviderEditorTestView(props: {
  readonly detail: AgentSessionDetail;
  readonly discoverModels: () => Promise<AgentModelCatalog>;
  readonly discoverProviders: () => Promise<OpenRouterProviderCatalog>;
}): ReturnType<typeof SessionProviderUpdateEditor> {
  return (
    <SessionProviderUpdateEditor
      credentials={[
        {
          id: props.detail.credentialId,
          label: "Session credential",
          provider: props.detail.provider,
        },
      ]}
      detail={props.detail}
      disabled={false}
      onApply={() => Promise.resolve(true)}
      onDiscoverModels={props.discoverModels}
      onDiscoverProviders={props.discoverProviders}
    />
  );
}

function mountProviderEditor(
  detail: AgentSessionDetail,
  catalog: AgentModelCatalog,
  providerCatalog: OpenRouterProviderCatalog = { providers: [] },
) {
  const discoverModels = vi.fn(() => Promise.resolve(catalog));
  const discoverProviders = vi.fn(() => Promise.resolve(providerCatalog));
  const container = mount(() => (
    <ProviderEditorTestView
      detail={detail}
      discoverModels={discoverModels}
      discoverProviders={discoverProviders}
    />
  ));
  return { container, discoverModels, discoverProviders };
}

function selectedProviderDraftValue(
  container: ParentNode,
  name: "openRouterProviderTag" | "sessionProviderModel",
): string {
  return queryTestElementAs(
    container,
    `input[name='${name}']`,
    HTMLInputElement,
  ).value;
}

async function mountedOpenRouterEditor() {
  const mounted = mountProviderEditor(
    OPENROUTER_DETAIL,
    MODEL_CATALOG,
    OPENROUTER_PROVIDER_CATALOG,
  );
  clickTestButton(mounted.container, "[data-session-provider-toggle='true']");
  await vi.waitFor(() => {
    expect(
      selectedProviderDraftValue(mounted.container, "openRouterProviderTag"),
    ).toBe("together");
  });
  return mounted;
}

const chooseProviderUpdateOption = chooseTestOption;

function expectOpenRouterDraft(container: ParentNode): void {
  expect(selectedProviderDraftValue(container, "sessionProviderModel")).toBe(
    "model-2",
  );
  expect(selectedProviderDraftValue(container, "openRouterProviderTag")).toBe(
    "together",
  );
}

function expanded(control: HTMLButtonElement): boolean {
  return control.getAttribute("aria-expanded") === "true";
}

const PROVIDER_DESCRIPTION =
  "Change the model account, provider, model, or OpenRouter serving provider for future turns.";
const PROVIDER_CONTROL_SELECTORS = [
  "[data-custom-select='sessionProviderCredential']",
  "[data-custom-select='sessionProviderModel']",
  "[data-session-provider-update-submit='true']",
] as const;

function expectProviderControls(
  container: ParentNode,
  toggle: HTMLButtonElement,
  expectedExpanded: boolean,
): void {
  expect(expanded(toggle)).toBe(expectedExpanded);
  expect(container.textContent?.includes(PROVIDER_DESCRIPTION)).toBe(
    expectedExpanded,
  );
  for (const selector of PROVIDER_CONTROL_SELECTORS) {
    expect(container.querySelector(selector) !== null).toBe(expectedExpanded);
  }
}

function expectProviderSectionPadding(
  section: HTMLElement,
  expected: "py-1.5" | "py-2",
): void {
  expect(section.classList).toContain(expected);
  expect(section.classList).not.toContain(
    expected === "py-1.5" ? "py-2" : "py-1.5",
  );
}

afterEach(() => {
  disposeView?.();
  disposeView = undefined;
  document.body.textContent = "";
});

test("keeps session provider controls collapsed until expanded", () => {
  const { container } = mountProviderEditor(
    TEST_SESSION_DETAIL,
    testAgentModelCatalog({ id: TEST_SESSION_DETAIL.model }),
  );
  const toggle = queryTestElementAs(
    container,
    "[data-session-provider-toggle='true']",
    HTMLButtonElement,
  );

  const providerSection = queryTestElementAs(
    container,
    "[data-session-editor-kind='provider']",
    HTMLElement,
  );

  expectProviderSectionPadding(providerSection, "py-1.5");
  expect(providerSection.classList).not.toContain("py-0");
  expectProviderControls(container, toggle, false);

  toggle.click();

  expectProviderSectionPadding(providerSection, "py-2");
  expectProviderControls(container, toggle, true);

  toggle.click();

  expectProviderSectionPadding(providerSection, "py-1.5");
  expectProviderControls(container, toggle, false);
});

test("preserves the session OpenRouter serving provider after discovery", async () => {
  const { container } = mountProviderEditor(
    OPENROUTER_DETAIL,
    MODEL_CATALOG,
    OPENROUTER_PROVIDER_CATALOG,
  );
  clickTestButton(container, "[data-session-provider-toggle='true']");
  const servingProvider = queryTestElementAs(
    container,
    "#session-openrouter-provider",
    HTMLButtonElement,
  );

  const selectedProvider = queryTestElementAs(
    container,
    "input[name='openRouterProviderTag']",
    HTMLInputElement,
  );

  await vi.waitFor(() => {
    expect(selectedProvider.value).toBe("together");
    expect(servingProvider.textContent).toContain("Together");
  });
  expect(servingProvider.textContent).not.toContain(
    "OpenRouter automatic routing",
  );
});

test("rediscovers providers only when the session provider selection changes", async () => {
  const catalog = {
    ...MODEL_CATALOG,
    models: [
      ...MODEL_CATALOG.models,
      ...testAgentModelCatalog({ id: "model-3", label: "Model 3" }).models,
    ],
  };
  const [detail, setDetail] = createSignal(OPENROUTER_DETAIL);
  const discoverModels = vi.fn<() => Promise<AgentModelCatalog>>();
  discoverModels.mockResolvedValue(catalog);
  const discoverProviders = vi.fn<() => Promise<OpenRouterProviderCatalog>>();
  discoverProviders.mockResolvedValue(OPENROUTER_PROVIDER_CATALOG);
  mount(() => (
    <ProviderEditorTestView
      detail={detail()}
      discoverModels={discoverModels}
      discoverProviders={discoverProviders}
    />
  ));
  await vi.waitFor(() => {
    expect(discoverProviders).toHaveBeenCalledTimes(1);
  });

  setDetail({ ...OPENROUTER_DETAIL, updatedAt: 3 });
  await Promise.resolve();

  expect(discoverModels).toHaveBeenCalledTimes(1);
  expect(discoverProviders).toHaveBeenCalledTimes(1);

  setDetail({ ...OPENROUTER_DETAIL, model: "model-3", updatedAt: 4 });
  await vi.waitFor(() => {
    expect(discoverProviders).toHaveBeenCalledTimes(2);
  });
  expect(discoverProviders).toHaveBeenLastCalledWith("credential-1", "model-3");
});

test("reselecting the current model preserves its serving provider", async () => {
  const { container, discoverProviders } = await mountedOpenRouterEditor();

  chooseProviderUpdateOption(container, "#session-provider-model", "model-2");

  expectOpenRouterDraft(container);
  expect(discoverProviders).toHaveBeenCalledTimes(1);
});

test("reselecting the current credential preserves its model and serving provider", async () => {
  const { container, discoverModels } = await mountedOpenRouterEditor();

  chooseProviderUpdateOption(
    container,
    "#session-provider-credential",
    "openrouter:credential-1",
  );

  expectOpenRouterDraft(container);
  expect(discoverModels).toHaveBeenCalledTimes(1);
});

test("surfaces a provider change blocked by the retained cap", async () => {
  const detail = { ...TEST_SESSION_DETAIL, userContextTokenCap: 120_000 };
  const apply = vi.fn(() => Promise.reject(invalidContextCapError()));
  const container = mount(() => (
    <SessionProviderUpdateEditor
      credentials={[modelCredential(detail)]}
      detail={detail}
      disabled={false}
      onApply={apply}
      onDiscoverModels={modelCatalogDiscovery}
      onDiscoverProviders={() => providerDiscovery()}
    />
  ));
  await submitProviderChange(container);

  await expectTestText(container, RETAINED_CAP_ERROR);
  expect(apply).toHaveBeenCalledOnce();
});

test("clears the cap and retries a blocked model change", async () => {
  const cappedDetail = {
    ...TEST_SESSION_DETAIL,
    userContextTokenCap: 120_000,
  };
  const failure = invalidContextCapError();
  let detail: AgentSessionDetail = cappedDetail;
  const command = vi.fn((operation: string) => {
    if (operation === "sessions.models") return Promise.resolve(MODEL_CATALOG);
    if (operation === "sessions.set_context_token_cap") {
      detail = {
        ...detail,
        updatedAt: detail.updatedAt + 1,
        userContextTokenCap: null,
      };
      return Promise.resolve(detail);
    }
    if (operation === "sessions.update_provider") {
      if (detail.userContextTokenCap !== null) return Promise.reject(failure);
      detail = {
        ...detail,
        maxContextTokens: 64_000,
        model: "model-2",
        updatedAt: detail.updatedAt + 1,
      };
      return Promise.resolve(detail);
    }
    return Promise.reject(new Error(`Unexpected operation: ${operation}`));
  });
  const initial = initialSessionViewState();
  const reactive = createReactiveState<SessionViewState>({
    ...initial,
    detail,
    selectedId: detail.id,
    sessions: [detail],
    transcriptFilters: { ...initial.transcriptFilters },
  });
  const controller = new SessionController(
    ...([reactive, undefined, null, { command }] as const),
  );
  const credentials = [
    testSessionCredentialOption({ ...modelCredential(detail, "OpenAI") }),
  ];
  const renderDetail = (): ReturnType<typeof SessionDetail> => (
    <SessionDetail
      controller={controller}
      credentialAvailable
      credentials={credentials}
      onOpenDirectoryPicker={vi.fn()}
      runners={Array.of()}
      state={reactive.state()}
    />
  );
  const container = mount(renderDetail);
  await submitProviderChange(container);
  await expectTestText(container, RETAINED_CAP_ERROR);

  clickTestButton(container, "[data-session-cap-toggle='true']");
  const capInput = queryTestElementAs(
    container,
    "#session-detail-context-token-cap",
    HTMLInputElement,
  );
  setTestInputValue(capInput, "");
  capInput.form?.requestSubmit();
  await vi.waitFor(() => {
    const cap = reactive.state().detail?.userContextTokenCap;
    if (cap !== null) throw new Error(`Context cap is still ${String(cap)}`);
  });

  clickTestButton(container, "[data-session-provider-update-confirm='true']");
  await vi.waitFor(() => {
    const state = reactive.state().detail;
    const confirm = container.querySelector(
      "[data-session-provider-update-confirm='true']",
    );
    if (state?.model !== "model-2" || confirm !== null) {
      throw new Error("The retried provider update has not completed");
    }
  });
  const providerUpdates = command.mock.calls.reduce(
    (count, [operation]) =>
      count + (operation === "sessions.update_provider" ? 1 : 0),
    0,
  );
  expect(providerUpdates).toBe(2);
});

test("warns and requires explicit confirmation before changing providers", async () => {
  const updated = Object.assign(
    { ...TEST_SESSION_DETAIL },
    {
      credentialId: "credential-2",
      generation: 1,
      model: "model-2",
      provider: "openrouter" as const,
      updatedAt: 3,
    },
  );
  const command = vi.fn((operation: string) =>
    operation === "sessions.models"
      ? Promise.resolve(MODEL_CATALOG)
      : Promise.resolve(updated),
  );
  const initial = initialSessionViewState();
  const selected = {
    detail: TEST_SESSION_DETAIL,
    selectedId: TEST_SESSION_DETAIL.id,
    sessions: [TEST_SESSION_DETAIL],
  };
  const reactive = createReactiveState<SessionViewState>({
    ...Object.assign(initial, selected),
    transcriptFilters: Object.assign({}, initial.transcriptFilters),
  });
  const transport: { command: typeof command } = { command };
  const controller = new SessionController(
    reactive,
    undefined,
    null,
    transport,
  );
  const container = mount(() => (
    <SessionDetail
      controller={controller}
      credentialAvailable
      credentials={[
        testSessionCredentialOption({
          id: "credential-1",
          isDefault: true,
          label: "OpenAI",
          provider: "openai",
        }),
        testSessionCredentialOption({
          id: "credential-2",
          label: "OpenRouter",
          provider: "openrouter",
        }),
      ]}
      onOpenDirectoryPicker={() => undefined}
      runners={[]}
      state={reactive.state()}
    />
  ));
  await expectTestText(container, "Session provider");
  clickTestButton(container, "[data-session-provider-toggle='true']");

  clickTestButton(container, "[data-session-provider-update-submit='true']");

  const dialog = queryTestElementAs(
    container,
    "[role='dialog']",
    HTMLDivElement,
  );
  expect(dialog.textContent).toContain(SESSION_PROVIDER_CACHE_WARNING);
  const providerUpdates = () =>
    command.mock.calls.filter(
      ([operation]) => operation === "sessions.update_provider",
    );
  expect(providerUpdates()).toHaveLength(0);

  clickTestButton(dialog, "[data-session-provider-update-confirm='true']");

  await vi.waitFor(() => {
    expect(providerUpdates()).toHaveLength(1);
  });
  expect(command).toHaveBeenCalledWith(
    "sessions.update_provider",
    expect.objectContaining({ confirmedCacheDrop: true }),
  );
});
