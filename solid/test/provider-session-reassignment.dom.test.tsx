import { afterEach, expect, test, vi } from "vitest";
import { providerCredentialSessionReassignmentPath } from "../../shared/routes.ts";
import {
  OPENAI_PANEL,
  createProviderViewState,
  type ProviderCredential,
} from "../provider-client.tsx";
import { ProviderController } from "../provider-controller.ts";
import { createReactiveState } from "../reactive-state.ts";
import {
  disposeTestViews,
  expectTestText,
  mountTestView,
} from "./dom-test-helpers.ts";
import { openAiProviderPanel } from "./provider-panel-fixtures.tsx";

const CREDENTIAL: ProviderCredential = {
  accountId: "account-1",
  id: "credential-1",
  isDefault: true,
  label: "Primary account",
  source: "oauth",
};
const disposals: (() => void)[] = [];
const originalFetch = globalThis.fetch;

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent.trim() === text,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new TypeError(`Missing button: ${text}`);
  }
  return found;
}

function mount() {
  const controller = new ProviderController(
    OPENAI_PANEL,
    createReactiveState(createProviderViewState([CREDENTIAL])),
  );

  const container = mountTestView(
    () => openAiProviderPanel(controller),
    disposals,
  );
  return { container, controller };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  disposeTestViews(disposals);
});

test("requires confirmation and reports the exact migrated count", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ migratedSessionCount: 2 }));
  const { container } = mount();
  const trigger = button(container, "Switch sessions to this account");

  trigger.click();
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector("[role='dialog']")?.textContent).toContain(
    "A running turn keeps the account it already captured",
  );

  button(container, "Switch sessions").click();

  await expectTestText(container, "2 sessions switched to this account.");
  expect(fetch).toHaveBeenCalledWith(
    `${providerCredentialSessionReassignmentPath(
      OPENAI_PANEL.credentialsPath,
      CREDENTIAL.id,
    )}?workspaceId=global`,
    expect.objectContaining({ body: "{}", method: "POST" }),
  );
});

test("reset closes a pending dialog without restoring stale state", async () => {
  let resolve: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    () =>
      new Promise<Response>((available) => {
        resolve = available;
      }),
    { preconnect: originalFetch.preconnect },
  );
  const { container, controller } = mount();

  button(container, "Switch sessions to this account").click();
  button(container, "Switch sessions").click();
  controller.reset();
  resolve?.(Response.json({ migratedSessionCount: 1 }));
  await Promise.resolve();

  expect(container.querySelector("[role='dialog']")).toBeNull();
  expect(controller.state).toEqual(createProviderViewState(undefined));
});
