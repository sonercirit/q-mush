import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
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

afterEach(() => {
  disposeTestViews(DISPOSALS);
});

test("preserves a spawned child draft across unrelated parent updates", async () => {
  const onSpawn = vi.fn(() => Promise.resolve());
  const parent = {
    ...TEST_SESSION_DETAIL,
    status: "running" as const,
    tools: AGENT_SESSION_TOOL_NAMES,
  };
  const [detail, setDetail] = createSignal(parent);
  const discoverModels = vi.fn(() =>
    Promise.resolve(testAgentModelCatalog({ id: parent.model })),
  );
  const container = mountTestView(
    () => (
      <SessionSpawnEditor
        credentials={[
          {
            credential: {
              accountId: null,
              id: parent.credentialId,
              isDefault: true,
              label: "OpenAI account",
              source: "api_key",
            },
            provider: "openai",
          },
        ]}
        detail={detail()}
        onDiscoverModels={discoverModels}
        onSpawn={onSpawn}
        runners={[runnerSummary(1)]}
      />
    ),
    DISPOSALS,
  );
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

  await vi.waitFor(() => {
    expect(onSpawn).toHaveBeenCalledOnce();
  });
  expect(onSpawn).toHaveBeenCalledWith(
    expect.objectContaining({
      parentGeneration: parent.generation,
      parentSessionId: parent.id,
      prompt: "Review the failing tests",
      tools: AGENT_SESSION_TOOL_NAMES.filter((name) => name !== "bash"),
    }),
  );
});
