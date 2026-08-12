import { afterEach, expect, test, vi } from "vitest";
import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { testAgentModelOption } from "../shared/test/agent-model-fixtures.ts";
import { TEST_WORKSPACE_LIST } from "../shared/test/workspace-fixtures.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { PromptController } from "../solid/prompt-controller.ts";
import { createPromptViewState } from "../solid/prompt-state.ts";
import {
  BRAVE_SEARCH_PANEL,
  GENERIC_PANEL,
  OPENAI_PANEL,
  OPENROUTER_PANEL,
} from "../solid/provider-client.tsx";
import { ProviderController } from "../solid/provider-controller.ts";
import {
  createProviderViewState,
  type ProviderCredential,
} from "../solid/provider-credential-model.ts";
import type { ProviderPanelConfiguration } from "../solid/provider-panel-configuration.ts";
import { createReactiveState } from "../solid/reactive-state.ts";
import { createRunnerViewState } from "../solid/runner-client.tsx";
import { RunnerController } from "../solid/runner-controller.ts";
import { SessionController } from "../solid/session-controller.ts";
import { initialSessionViewState } from "../solid/session-state.ts";
import {
  clickTestButton,
  disposeTestViews,
  findTestButton,
  mountTestView,
} from "../solid/test/dom-test-helpers.ts";
import { TEST_PROMPT } from "../solid/test/prompt-fixtures.ts";
import { createWorkspaceViewState } from "../solid/workspace-client.tsx";
import { WorkspaceController } from "../solid/workspace-controller.ts";
import { Workspace } from "../solid/workspace-view.tsx";

const DISPOSALS: (() => void)[] = [];
const OPENROUTER_CREDENTIAL: ProviderCredential = {
  accountId: null,
  id: "credential-1",
  isDefault: true,
  isGlobal: true,
  label: "OpenRouter API key",
  source: "api_key",
  workspaceIds: [],
};

function providerController(
  configuration: ProviderPanelConfiguration,
): ProviderController {
  return new ProviderController(
    configuration,
    createReactiveState(createProviderViewState([])),
  );
}

function modelCatalog(): AgentModelCatalog {
  const image = testAgentModelOption({
    id: "openrouter/image-model",
    inputModalities: ["text", "image"],
    label: "Image model",
  });
  return {
    defaultModel: image.id,
    models: [
      image,
      testAgentModelOption({
        id: "openrouter/audio-model",
        inputModalities: ["audio"],
        label: "Audio model",
      }),
    ],
  };
}

function selectedFallbackModel(container: ParentNode): string | undefined {
  return container.querySelector<HTMLInputElement>(
    "input[name='attachmentFallbackModel']",
  )?.value;
}

afterEach(() => {
  disposeTestViews(DISPOSALS);
});

test("discovers global fallbacks through the mounted workspace", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() =>
      Promise.resolve(
        fetch.mock.calls.length === 1
          ? Response.json({ error: "workspace_unavailable" }, { status: 409 })
          : Response.json(modelCatalog()),
      ),
    );
  const openRouterState = createReactiveState(createProviderViewState([]));
  const prompts = new PromptController(
    createReactiveState(createPromptViewState([TEST_PROMPT])),
  );
  const container = mountTestView(
    () => (
      <Workspace
        agentSessions={
          new SessionController(
            createReactiveState(initialSessionViewState()),
            undefined,
            null,
          )
        }
        braveSearch={providerController(BRAVE_SEARCH_PANEL)}
        generic={providerController(GENERIC_PANEL)}
        logout={() => Promise.resolve()}
        logoutPending={false}
        openAi={providerController(OPENAI_PANEL)}
        openRouter={new ProviderController(OPENROUTER_PANEL, openRouterState)}
        prompts={prompts}
        runners={
          new RunnerController(createReactiveState(createRunnerViewState([])))
        }
        user={{ email: "user@example.com", id: "user-1", name: "User" }}
        workspaces={
          new WorkspaceController(
            undefined,
            createReactiveState(
              createWorkspaceViewState({
                defaultWorkspaceId: TEST_WORKSPACE_LIST.defaultWorkspaceId,
                workspaces: TEST_WORKSPACE_LIST.workspaces.slice(0, 1),
              }),
            ),
          )
        }
      />
    ),
    DISPOSALS,
  );

  expect(container.textContent).toContain(
    "Global attachment fallback settings",
  );
  expect(container.textContent).toContain(TEST_PROMPT.name);
  openRouterState.setState(createProviderViewState([OPENROUTER_CREDENTIAL]));

  await vi.waitUntil(
    () =>
      container
        .querySelector("[role='alert']")
        ?.textContent.includes(
          "That workspace is unavailable for model discovery.",
        ) === true,
  );
  const retry = findTestButton(container, "Retry model discovery");
  if (!(retry instanceof HTMLButtonElement)) {
    throw new TypeError("The retry control was not rendered");
  }
  retry.click();
  await vi.waitUntil(
    () => selectedFallbackModel(container) === "openrouter/image-model",
  );

  const modality = container.querySelector(
    "[data-custom-select='attachmentFallbackModality']",
  );
  expect(modality).not.toBeNull();
  expect(
    container.querySelector<HTMLInputElement>(
      "input[name='attachmentFallbackModality']",
    )?.value,
  ).toBe("image");
  clickTestButton(
    container,
    "[data-custom-select='attachmentFallbackModality'] > button",
  );
  clickTestButton(
    container,
    "[data-custom-select='attachmentFallbackModality'] [data-option-value='audio']",
  );
  await vi.waitUntil(
    () => selectedFallbackModel(container) === "openrouter/audio-model",
  );

  const secondCredential = {
    ...OPENROUTER_CREDENTIAL,
    id: "credential-2",
    label: "Second OpenRouter key",
  };
  openRouterState.setState(
    createProviderViewState([OPENROUTER_CREDENTIAL, secondCredential]),
  );
  clickTestButton(
    container,
    "[data-custom-select='attachmentFallbackCredential'] > button",
  );
  clickTestButton(container, "[data-option-value='openrouter:credential-2']");

  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `/api/sessions/models?credentialId=credential-1&provider=openrouter&workspaceId=${GLOBAL_WORKSPACE_ID}`,
    `/api/sessions/models?credentialId=credential-1&provider=openrouter&workspaceId=${GLOBAL_WORKSPACE_ID}`,
    `/api/sessions/models?credentialId=credential-1&provider=openrouter&workspaceId=${GLOBAL_WORKSPACE_ID}`,
    `/api/sessions/models?credentialId=credential-2&provider=openrouter&workspaceId=${GLOBAL_WORKSPACE_ID}`,
  ]);
});
