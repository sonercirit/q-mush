import { expect, vi } from "vitest";
import { OPENAI_PANEL } from "../provider-client.tsx";
import type { ProviderController } from "../provider-controller.ts";
import { type ProviderCredential } from "../provider-credential-model.ts";
import { disposeTestViews, mountTestView } from "./dom-test-helpers.ts";
import { openAiProviderPanel } from "./provider-panel-fixtures.tsx";

export const TEST_PROVIDER_CREDENTIAL: ProviderCredential = {
  accountId: "account-1",
  id: "credential-1",
  isDefault: true,
  label: "Primary account",
  source: "oauth",
};

const originalFetch = globalThis.fetch;
const disposals: (() => void)[] = [];

export interface PendingProviderResponse {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
}

export function pendingProviderResponse(): PendingProviderResponse {
  let resolveResponse: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return {
    promise,
    resolve: (response) => resolveResponse?.(response),
  };
}

export function expectProviderFetchPending(
  fetch: ReturnType<typeof vi.fn>,
): void {
  expect(fetch).not.toHaveBeenCalled();
}

export function providerTestButton(
  container: ParentNode,
  text: string,
): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent.trim() === text,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new TypeError(`Missing button: ${text}`);
  }
  return found;
}

export function mountProviderTestPanel(
  controller: ProviderController,
): HTMLDivElement {
  return mountTestView(() => openAiProviderPanel(controller), disposals);
}

function resetProviderDomTest(): void {
  globalThis.fetch = originalFetch;
  disposeTestViews(disposals);
}

export function resetProviderDomTestMocks(): void {
  resetProviderDomTest();
  vi.restoreAllMocks();
}

export function originalProviderTestFetch(): typeof globalThis.fetch {
  return originalFetch;
}

export { OPENAI_PANEL };
