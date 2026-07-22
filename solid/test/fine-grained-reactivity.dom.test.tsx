import { type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import {
  OPENAI_PANEL,
  ProviderPanel,
  createProviderViewState,
  type ProviderCredential,
  type ProviderViewState,
} from "../provider-client.tsx";
import { ProviderController } from "../provider-controller.ts";
import { createReactiveState } from "../reactive-state.ts";
import {
  RunnerPanel,
  createRunnerViewState,
  type RunnerViewState,
} from "../runner-client.tsx";
import { RunnerController } from "../runner-controller.ts";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { initialSessionViewState } from "../session-state.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

function mount(renderView: () => JSX.Element): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  disposals.push(render(renderView, container));
  return container;
}

function query(container: ParentNode, selector: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`The test element ${selector} was not rendered`);
  }
  return element;
}

function click(container: ParentNode, selector: string): void {
  const control = query(container, selector);
  if (!(control instanceof HTMLButtonElement)) {
    throw new TypeError(`The test control ${selector} is not a button`);
  }
  control.click();
}

function credential(id: string, label: string): ProviderCredential {
  return {
    accountId: null,
    id,
    isDefault: true,
    label,
    source: "api_key",
  };
}

function stubSessionRequests(catalog: AgentModelCatalog): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Promise.resolve(
        Response.json(url.includes("/models?") ? catalog : TEST_SESSION_DETAIL),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  disposals.push(() => {
    globalThis.fetch = originalFetch;
  });
}

afterEach(() => {
  while (disposals.length > 0) {
    disposals.pop()?.();
  }
  document.body.replaceChildren();
});

test("provider loading, error, retry, and list updates preserve the panel", async () => {
  const reactive = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const controller = new ProviderController(OPENAI_PANEL, reactive);
  const view = (): JSX.Element => (
    <ProviderPanel configuration={OPENAI_PANEL} controller={controller} />
  );
  const container = mount(view);
  const panel = query(container, "[data-provider-panel='openai']");

  expect(container.textContent).toContain("Loading OpenAI connections…");

  reactive.setState({
    ...reactive.state(),
    error: "OpenAI is unavailable",
  });
  expect(reactive.state().error).toBe("OpenAI is unavailable");
  expect(container.textContent).toContain("OpenAI is unavailable");
  const retry = vi.spyOn(controller, "load").mockResolvedValue();
  click(container, "[role='alert'] button");
  expect(retry).toHaveBeenCalledOnce();

  const primary = credential("credential-1", "Primary");
  reactive.setState(createProviderViewState([primary]));
  await vi.waitFor(() => {
    expect(container.textContent).toContain(primary.label);
  });
  expect(container.querySelector("[data-provider-panel='openai']")).toBe(panel);

  reactive.setState(createProviderViewState([]));
  expect(container.textContent).toContain("No OpenAI accounts or keys yet");
  expect(container.querySelector("[data-provider-panel='openai']")).toBe(panel);
});

test("realtime runner changes update the list without remounting the panel", () => {
  const reactive = createReactiveState<RunnerViewState>(
    createRunnerViewState([]),
  );
  const controller = new RunnerController(reactive);
  const container = mount(() => <RunnerPanel controller={controller} />);
  const panel = query(container, "[data-runner-panel='true']");

  expect(container.textContent).toContain("No runners yet");
  controller.applyRealtime([runnerSummary(1)]);
  expect(container.textContent).toContain("workstation");

  const runnerItem = query(container, "[data-runner-id='runner-1']").closest(
    "li",
  );
  controller.applyRealtime([
    { ...runnerSummary(2), name: "renamed workstation" },
  ]);

  expect(container.textContent).toContain("renamed workstation");
  expect(container.textContent).toContain("Online");
  expect(
    query(container, "[data-runner-id='runner-1']").closest("li"),
  ).not.toBe(runnerItem);
  expect(container.querySelector("[data-runner-panel='true']")).toBe(panel);
});

test("session resources, drafts, realtime lists, and selected details update in place", async () => {
  const sessionState = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    sessions: [],
  });
  const runnerState = createReactiveState<RunnerViewState>(
    createRunnerViewState([]),
  );
  const openAiState = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const openRouterState = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const controller = new SessionController(sessionState);
  const modelLabel = "Reactive model";
  const primaryCredentialLabel = "Primary";
  stubSessionRequests({
    defaultModel: "model-1",
    models: [
      {
        contextWindow: 128_000,
        id: "model-1",
        inputModalities: ["text"],
        label: modelLabel,
        outputModalities: ["text"],
        reasoningEfforts: ["high"],
      },
    ],
  });
  const container = mount(() => (
    <SessionPanel
      controller={controller}
      openAi={openAiState.state}
      openRouter={openRouterState.state}
      runners={runnerState.state}
    />
  ));
  const panel = query(container, "[data-session-panel='true']");
  const prompt = query(container, "#session-prompt");
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError("The session prompt is not a textarea");
  }

  expect(container.textContent).toContain("No online runners");
  expect(container.textContent).toContain("Loading credentials…");
  expect(container.textContent).toContain("No sessions yet");

  runnerState.setState(createRunnerViewState([runnerSummary(1)]));
  openAiState.setState(
    createProviderViewState([
      credential("credential-1", primaryCredentialLabel),
    ]),
  );
  openRouterState.setState(createProviderViewState([]));
  await Promise.resolve();

  expect(container.textContent).toContain("workstation");
  expect(container.textContent).toContain(primaryCredentialLabel);
  await vi.waitFor(() => {
    expect(query(container, "#session-model").textContent).toContain(
      modelLabel,
    );
  });

  controller.setDraftField("prompt", "Keep this task focused");
  expect(prompt.value).toBe("Keep this task focused");
  expect(query(container, "#session-prompt")).toBe(prompt);

  controller.applyRealtime([summaryFromDetail(TEST_SESSION_DETAIL)]);
  expect(container.textContent).toContain("Fix the app");
  click(container, `[data-session-id='${TEST_SESSION_DETAIL.id}']`);
  const sessionPromptLabel = "System prompt";
  await vi.waitFor(() => {
    expect(container.textContent).toContain(sessionPromptLabel);
  });
  expect(container.textContent).toContain("Fix the app");
  expect(container.querySelector("[data-session-panel='true']")).toBe(panel);
  expect(query(container, "#session-prompt")).toBe(prompt);
});
