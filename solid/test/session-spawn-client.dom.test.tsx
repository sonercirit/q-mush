import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import type { UserSpawnSessionSelection } from "../session-controller-spawn.ts";
import { SessionSpawnEditor } from "../session-spawn-client.tsx";
import {
  clickTestButton,
  disposeTestViews,
  mountTestView,
  queryTestElementAs,
  setTestInputValue,
} from "./dom-test-helpers.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const DISPOSALS: (() => void)[] = [];
type SpawnEditorProps = Parameters<typeof SessionSpawnEditor>[0];

function mountSpawnEditor(options: {
  readonly detail: () => SpawnEditorProps["detail"];
  readonly onDiscoverModels: SpawnEditorProps["onDiscoverModels"];
  readonly onSpawn: SpawnEditorProps["onSpawn"];
}): HTMLDivElement {
  return mountTestView(() => {
    const detail = options.detail();
    return (
      <SessionSpawnEditor
        credentials={[
          {
            credential: {
              accountId: null,
              id: detail.credentialId,
              isDefault: true,
              label: "OpenAI account",
              source: "api_key",
            },
            provider: "openai",
          },
        ]}
        detail={detail}
        onDiscoverModels={options.onDiscoverModels}
        onSpawn={options.onSpawn}
        runners={[runnerSummary(1)]}
      />
    );
  }, DISPOSALS);
}

function resolvedSpawn(): Promise<void> {
  return Promise.resolve();
}

function settledSpawnCall(onSpawn: ReturnType<typeof vi.fn>): Promise<boolean> {
  return vi.waitUntil(() => onSpawn.mock.calls.length === 1);
}

afterEach(() => {
  disposeTestViews(DISPOSALS);
});

test("keeps spawn controls and description collapsed until expanded", () => {
  const container = mountSpawnEditor({
    detail: () => TEST_SESSION_DETAIL,
    onDiscoverModels: () =>
      Promise.resolve(testAgentModelCatalog({ id: TEST_SESSION_DETAIL.model })),
    onSpawn: resolvedSpawn,
  });
  const toggle = queryTestElementAs(
    container,
    "[data-session-spawn-toggle='true']",
    HTMLButtonElement,
  );
  const description =
    "Start a child whose completion is reported back to this session.";

  expect(toggle.textContent).toBe("Expand");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain(description);
  expect(container.querySelector("[name='spawnPrompt']")).toBeNull();

  toggle.click();

  expect(toggle.textContent).toBe("Collapse");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain(description);
  expect(container.querySelector("[name='spawnPrompt']")).toBeInstanceOf(
    HTMLTextAreaElement,
  );
});

test("preserves a spawned child draft across unrelated parent updates", async () => {
  const onSpawn = vi.fn(resolvedSpawn);
  const parent = {
    ...TEST_SESSION_DETAIL,
    status: "running" as const,
    tools: AGENT_SESSION_TOOL_NAMES,
  };
  const [detail, setDetail] = createSignal(parent);
  const discoverModels = vi.fn(() =>
    Promise.resolve(testAgentModelCatalog({ id: parent.model })),
  );
  const container = mountSpawnEditor({
    detail,
    onDiscoverModels: discoverModels,
    onSpawn,
  });
  await vi.waitFor(() => {
    expect(discoverModels).toHaveBeenCalledOnce();
  });

  clickTestButton(container, "[data-session-spawn-toggle='true']");
  clickTestButton(container, "[data-tool-picker-toggle='true']");
  const bashTool = queryTestElementAs(
    container,
    "input[value='bash']",
    HTMLInputElement,
  );
  bashTool.click();
  const prompt = queryTestElementAs(
    container,
    "textarea[name='spawnPrompt']",
    HTMLTextAreaElement,
  );
  setTestInputValue(prompt, "Review the failing tests");

  setDetail((current) => ({
    ...current,
    updatedAt: current.updatedAt + 1,
  }));
  await Promise.resolve();

  expect(prompt.value).toBe("Review the failing tests");
  expect(bashTool.checked).toBe(false);
  expect(discoverModels).toHaveBeenCalledOnce();

  clickTestButton(container, "[data-session-spawn-submit='true']");

  await settledSpawnCall(onSpawn);
  expect(onSpawn).toHaveBeenCalledWith(
    expect.objectContaining({
      parentGeneration: parent.generation,
      parentSessionId: parent.id,
      prompt: "Review the failing tests",
      tools: AGENT_SESSION_TOOL_NAMES.filter((name) => name !== "bash"),
    }),
  );
});

test("Ctrl+Enter submits the spawn editor and its button shows a hint", async () => {
  const parent = {
    ...TEST_SESSION_DETAIL,
    tools: [...AGENT_SESSION_TOOL_NAMES],
  };
  const spawned: UserSpawnSessionSelection[] = [];
  const onSpawn = (selection: UserSpawnSessionSelection): Promise<void> => {
    spawned.push(selection);
    return Promise.resolve();
  };
  const container = mountSpawnEditor({
    detail: () => parent,
    onDiscoverModels: () =>
      Promise.resolve(testAgentModelCatalog({ id: parent.model })),
    onSpawn,
  });
  clickTestButton(container, "[data-session-spawn-toggle='true']");
  const prompt = queryTestElementAs(
    container,
    "textarea[name='spawnPrompt']",
    HTMLTextAreaElement,
  );
  setTestInputValue(prompt, "Review keyboard support");
  prompt.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      ctrlKey: true,
      key: "Enter",
    }),
  );

  await vi.waitUntil(() => spawned.length === 1);
  const submitButton = queryTestElementAs(
    container,
    "[data-session-spawn-submit='true']",
    HTMLButtonElement,
  );
  expect(submitButton.textContent).toBe("Spawn childCtrl+Enter");
  expect(submitButton.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
});
