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
  clickTestButton,
  expectTestText,
  mountTestView,
  queryTestElementAs,
} from "./dom-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

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

function chooseProviderUpdateOption(
  container: ParentNode,
  selectId: string,
  value: string,
): void {
  clickTestButton(container, selectId);
  clickTestButton(container, `[data-option-value='${value}']`);
}

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
  for (const selector of PROVIDER_CONTROL_SELECTORS) {
    expect(container.querySelector(selector) !== null).toBe(expectedExpanded);
  }
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

  expectProviderControls(container, toggle, false);

  toggle.click();

  expectProviderControls(container, toggle, true);

  toggle.click();

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
        {
          credential: {
            accountId: null,
            id: "credential-1",
            isDefault: true,
            isGlobal: true,
            label: "OpenAI",
            source: "api_key",
            workspaceIds: [],
          },
          provider: "openai",
        },
        {
          credential: {
            accountId: null,
            id: "credential-2",
            isDefault: false,
            isGlobal: true,
            label: "OpenRouter",
            source: "api_key",
            workspaceIds: [],
          },
          provider: "openrouter",
        },
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
