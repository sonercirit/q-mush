import { expect, test } from "vitest";
import { TEST_WORKSPACE_LIST } from "../../shared/test/workspace-fixtures.ts";
import { PromptController } from "../../solid/prompt-controller.ts";
import { createPromptViewState } from "../../solid/prompt-state.ts";
import {
  BRAVE_SEARCH_PANEL,
  createProviderViewState,
  OPENAI_PANEL,
  OPENROUTER_PANEL,
  type ProviderPanelConfiguration,
} from "../../solid/provider-client.tsx";
import { ProviderController } from "../../solid/provider-controller.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { createRunnerViewState } from "../../solid/runner-client.tsx";
import { RunnerController } from "../../solid/runner-controller.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import { createWorkspaceViewState } from "../../solid/workspace-client.tsx";
import { WorkspaceController } from "../../solid/workspace-controller.ts";
import { Workspace } from "../../solid/workspace-view.tsx";
import { TEST_PROMPT } from "./prompt-fixtures.ts";
import { renderSolidToString } from "./render-solid.tsx";

const WORKSPACES = {
  defaultWorkspaceId: TEST_WORKSPACE_LIST.defaultWorkspaceId,
  workspaces: TEST_WORKSPACE_LIST.workspaces.slice(0, 1),
};

function providerController(
  configuration: ProviderPanelConfiguration,
): ProviderController {
  return new ProviderController(
    configuration,
    createReactiveState(createProviderViewState([])),
  );
}

test("keeps the prompt bank in the shared workspace composition", () => {
  const prompts = new PromptController(
    createReactiveState(createPromptViewState([TEST_PROMPT])),
  );
  const html = renderSolidToString(() => (
    <Workspace
      agentSessions={
        new SessionController(
          createReactiveState(initialSessionViewState()),
          undefined,
          null,
        )
      }
      braveSearch={providerController(BRAVE_SEARCH_PANEL)}
      logout={() => Promise.resolve()}
      logoutPending={false}
      openAi={providerController(OPENAI_PANEL)}
      openRouter={providerController(OPENROUTER_PANEL)}
      prompts={prompts}
      runners={
        new RunnerController(createReactiveState(createRunnerViewState([])))
      }
      user={{ email: "user@example.com", id: "user-1", name: "User" }}
      workspaces={
        new WorkspaceController(
          undefined,
          createReactiveState(createWorkspaceViewState(WORKSPACES)),
        )
      }
    />
  ));

  expect(html).toContain("Global connections");
  expect(html).toContain('data-prompt-bank="true"');
});
