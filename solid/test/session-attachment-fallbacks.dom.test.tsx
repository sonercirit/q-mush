import { afterEach, expect, test, vi } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import { AttachmentFallbackSettings } from "../session-attachment-fallbacks.tsx";
import {
  clickTestButton,
  disposeTestViews,
  findTestButton,
  mountTestView,
} from "./dom-test-helpers.ts";
import { testSessionCredentialOption } from "./session-credential-fixtures.ts";

const DISPOSALS: (() => void)[] = [];

afterEach(() => {
  disposeTestViews(DISPOSALS);
});

async function expectModelDiscovery(
  discoverModels: ReturnType<typeof vi.fn>,
  calls: number,
): Promise<void> {
  await vi.waitUntil(() => discoverModels.mock.calls.length === calls);
}

function fallbackCatalog(
  models: AgentModelCatalog["models"],
): AgentModelCatalog {
  return { defaultModel: models[0]?.id ?? "", models };
}

function fallbackCredential(provider: "openai" | "openrouter", label: string) {
  return testSessionCredentialOption({
    id: "credential-1",
    label,
    provider,
  });
}

function mountFallbackSettings(
  credential: ReturnType<typeof testSessionCredentialOption>,
  discoverModels: Parameters<
    typeof AttachmentFallbackSettings
  >[0]["onDiscoverModels"],
): HTMLDivElement {
  return mountTestView(
    () => (
      <AttachmentFallbackSettings
        credentials={[credential]}
        onDiscoverModels={discoverModels}
      />
    ),
    DISPOSALS,
  );
}

function fallbackModel(
  id: string,
  inputModalities: AgentModelCatalog["models"][number]["inputModalities"],
  label: string,
) {
  return testAgentModelOption({ id, inputModalities, label });
}

async function expectDiscoveredModel(
  discoverModels: ReturnType<typeof vi.fn>,
  container: ParentNode,
  calls: number,
  model: string,
): Promise<void> {
  await vi.waitUntil(
    () =>
      container.querySelector<HTMLInputElement>(
        "input[name='attachmentFallbackModel']",
      )?.value === model,
  );
  expect(discoverModels).toHaveBeenCalledTimes(calls);
}

function openFallbackSelect(container: ParentNode, name: string): void {
  clickTestButton(container, `[data-custom-select='${name}'] > button`);
}

test("offers routing modes in global fallback settings", async () => {
  const discoverModels = vi.fn(() =>
    Promise.resolve(
      fallbackCatalog([
        fallbackModel("image-model", ["text", "image"], "Image model"),
      ]),
    ),
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ providers: [] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  const container = mountFallbackSettings(
    fallbackCredential("openrouter", "OpenRouter credential"),
    discoverModels,
  );

  await expectDiscoveredModel(discoverModels, container, 1, "image-model");
  openFallbackSelect(container, "openRouterProviderTag");

  for (const label of [
    "OpenRouter automatic routing",
    "OpenRouter automatic routing without fallbacks",
    "OpenRouter sort by price",
    "OpenRouter sort by throughput",
    "OpenRouter sort by latency",
    "OpenRouter sort by quality for tool use",
  ]) {
    expect(container.textContent).toContain(label);
  }
  clickTestButton(container, "[data-option-value='q-mush-routing:throughput']");
  expect(
    container.querySelector<HTMLInputElement>(
      "input[name='openRouterProviderTag']",
    )?.value,
  ).toBe("q-mush-routing:throughput");
  const save = findTestButton(container, "Save global fallback");
  if (save === undefined) throw new TypeError("Missing fallback save button");
  save.click();

  await vi.waitFor(() => {
    const request = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(request?.[0]).toBe("/api/sessions/attachment-fallbacks");
    expect(request?.[1]?.method).toBe("PUT");
    expect(request?.[1]?.body).toContain(
      '"openRouterProviderTag":"q-mush-routing:throughput"',
    );
  });
});

test("offers only fallback models supporting the selected attachment modality", async () => {
  const catalog: AgentModelCatalog = {
    defaultModel: "text-model",
    models: [
      fallbackModel("text-model", ["text"], "Text model"),
      fallbackModel("image-model", ["text", "image"], "Image model"),
      fallbackModel("audio-model", ["audio"], "Audio model"),
    ],
  };
  const discoverModels = vi.fn(() => Promise.resolve(catalog));
  const container = mountFallbackSettings(
    fallbackCredential("openai", "Global credential"),
    discoverModels,
  );

  await expectModelDiscovery(discoverModels, 1);
  const modality = container.querySelector<HTMLSelectElement>("select");
  if (modality === null) throw new TypeError("Missing modality select");
  modality.value = "audio";
  modality.dispatchEvent(new Event("change", { bubbles: true }));

  await expectDiscoveredModel(discoverModels, container, 2, "audio-model");
  openFallbackSelect(container, "attachmentFallbackModel");

  expect(container.querySelector("[data-option-value='audio-model']")).not.toBe(
    null,
  );
  expect(container.querySelector("[data-option-value='image-model']")).toBe(
    null,
  );
  expect(container.querySelector("[data-option-value='text-model']")).toBe(
    null,
  );
});
