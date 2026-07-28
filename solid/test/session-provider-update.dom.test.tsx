import { afterEach, expect, test, vi } from "vitest";
import { SESSION_PROVIDER_CACHE_WARNING } from "../../shared/session-provider-update.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
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

let disposeView: (() => void) | undefined;

afterEach(() => {
  disposeView?.();
  disposeView = undefined;
  document.body.textContent = "";
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
  const viewDisposals: (() => void)[] = [];
  const container = mountTestView(
    () => (
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
    ),
    viewDisposals,
  );
  disposeView = viewDisposals[0];
  await expectTestText(container, "Session provider");

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
