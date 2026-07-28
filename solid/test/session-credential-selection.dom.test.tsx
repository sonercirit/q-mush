import { afterEach, expect, test, vi } from "vitest";
import {
  createProviderViewState,
  type ProviderCredential,
} from "../provider-client.tsx";
import { createReactiveState } from "../reactive-state.ts";
import { createRunnerViewState } from "../runner-client.tsx";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { initialSessionViewState } from "../session-state.ts";
import {
  clickTestButton,
  disposeTestViews,
  mountTestView,
  queryTestElement,
} from "./dom-test-helpers.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

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

function selectedAccountModel(payload: Record<string, unknown>) {
  const openRouter = payload["provider"] === "openrouter";
  return {
    contextWindow: 128_000,
    id: openRouter ? "openrouter/model" : "openai-model",
    inputModalities: ["text"],
    label: openRouter ? "OpenRouter model" : "OpenAI model",
    outputModalities: ["text"],
    pricing: null,
    reasoningEfforts: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  disposeTestViews(disposals);
});

test("changing the new-session account drives model loading and creation", async () => {
  const openAiCredential = credential("credential-1", "OpenAI account", true);
  const openRouterCredential = credential(
    "credential-2",
    "OpenRouter account",
    false,
  );
  const command = vi.fn(
    (operation: string, payload: Record<string, unknown>) =>
      operation === "sessions.models"
        ? Promise.resolve({
            defaultModel: null,
            models: [selectedAccountModel(payload)],
          })
        : Promise.resolve({
            ...TEST_SESSION_DETAIL,
            credentialId: String(payload["credentialId"]),
            model: String(payload["model"]),
            provider:
              payload["provider"] === "openrouter" ? "openrouter" : "openai",
            status: "queued",
          }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
    Promise.resolve(
      Response.json(isProviderDiscoveryRequest(input) ? { providers: [] } : {}),
    ),
  );
  const reactive = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    sessions: [],
  });
  const controller = new SessionController(reactive, undefined, null, {
    command,
  });
  const resources = {
    ai: createProviderViewState([openAiCredential]),
    router: createProviderViewState([openRouterCredential]),
    runner: createRunnerViewState([runnerSummary(1)]),
  };
  const panel = (): ReturnType<typeof SessionPanel> =>
    SessionPanel({
      controller,
      openAi: () => resources.ai,
      openRouter: () => resources.router,
      runners: () => resources.runner,
    });
  const container = mountTestView(panel, disposals);

  await waitForModel(container, "OpenAI model");
  clickTestButton(container, "#session-credential");
  clickTestButton(container, "[data-option-value='openrouter:credential-2']");

  await waitForModel(container, "OpenRouter model");
  controller.setDraftField("prompt", "Use the selected account");
  await controller.create();

  expect(command).toHaveBeenCalledWith("sessions.models", {
    credentialId: "credential-2",
    provider: "openrouter",
  });
  expect(command).toHaveBeenCalledWith(
    "sessions.create",
    expect.objectContaining({
      credentialId: "credential-2",
      model: "openrouter/model",
      provider: "openrouter",
    }),
  );
});
