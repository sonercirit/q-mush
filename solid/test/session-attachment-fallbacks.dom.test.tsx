import { afterEach, expect, test, vi } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import { SESSION_MODELS_PATH } from "../../shared/routes.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import { AttachmentFallbackSettings } from "../session-attachment-fallbacks.tsx";
import { discoverProviderUpdateModels } from "../session-provider-update-controller.ts";
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
  vi.restoreAllMocks();
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

function fallbackSelectionValue(
  container: ParentNode,
  name: string,
): string | undefined {
  return container.querySelector<HTMLInputElement>(`input[name='${name}']`)
    ?.value;
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

test("discovers global fallback models over HTTP without realtime", async () => {
  const catalog = fallbackCatalog([
    fallbackModel("openrouter/image-model", ["text", "image"], "Image model"),
  ]);
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json(catalog));

  await expect(
    discoverProviderUpdateModels(undefined, "openrouter", "credential-1"),
  ).resolves.toMatchObject(catalog);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe(
    `${SESSION_MODELS_PATH}?credentialId=credential-1&provider=openrouter`,
  );
  expect(new Headers(init?.headers).get("accept")).toBe("application/json");
});

test("reports descriptive HTTP discovery failures", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: "provider_unavailable",
        message: "Model discovery failed with status 503",
      },
      { status: 502 },
    ),
  );

  await expect(
    discoverProviderUpdateModels(undefined, "openrouter", "credential-1"),
  ).resolves.toEqual({ error: "Model discovery failed with status 503" });
});

test("shows an explicit fallback model discovery error and retries", async () => {
  const catalog = fallbackCatalog([
    fallbackModel("image-model", ["text", "image"], "Image model"),
  ]);
  const discoverModels = vi
    .fn<() => Promise<AgentModelCatalog | { readonly error: string }>>()
    .mockResolvedValueOnce({
      error: "OpenRouter model discovery is temporarily unavailable.",
    })
    .mockResolvedValueOnce(catalog);
  const container = mountFallbackSettings(
    fallbackCredential("openrouter", "OpenRouter credential"),
    discoverModels,
  );

  await expectModelDiscovery(discoverModels, 1);
  await vi.waitFor(() => {
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "OpenRouter model discovery is temporarily unavailable.",
    );
  });
  const retry = findTestButton(container, "Retry model discovery");
  if (retry === undefined) throw new TypeError("Missing model discovery retry");
  retry.click();

  await expectDiscoveredModel(discoverModels, container, 2, "image-model");
  expect(container.querySelector("[role='alert']")).toBeNull();
});

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
  const selectNames = [
    "attachmentFallbackModality",
    "attachmentFallbackCredential",
    "attachmentFallbackModel",
    "openRouterProviderTag",
  ] as const;
  for (const name of selectNames) {
    openFallbackSelect(container, name);
    for (const candidate of selectNames) {
      expect(
        container
          .querySelector(`[data-custom-select='${candidate}']`)
          ?.getAttribute("data-custom-select-open"),
      ).toBe(String(candidate === name));
    }
  }

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
  expect(
    container.querySelector("select[name='attachmentFallbackModality']"),
  ).toBeNull();
  const modalityControl = container.querySelector(
    "[data-custom-select='attachmentFallbackModality']",
  );
  expect(modalityControl).not.toBeNull();
  expect(fallbackSelectionValue(container, "attachmentFallbackModality")).toBe(
    "image",
  );
  openFallbackSelect(container, "attachmentFallbackModality");
  for (const label of ["Image", "Video", "Audio", "PDF", "File"]) {
    expect(modalityControl?.textContent).toContain(label);
  }
  clickTestButton(
    container,
    "[data-custom-select='attachmentFallbackModality'] [data-option-value='audio']",
  );
  expect(fallbackSelectionValue(container, "attachmentFallbackModality")).toBe(
    "audio",
  );

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
