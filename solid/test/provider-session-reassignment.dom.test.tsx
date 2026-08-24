import { afterEach, expect, test, vi } from "vitest";
import { providerCredentialSessionReassignmentPath } from "../../shared/routes.ts";
import { createProviderController } from "../provider-controller.ts";
import { createProviderViewState } from "../provider-credential-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import { expectTestText } from "./dom-test-helpers.ts";
import {
  expectProviderFetchPending,
  mountProviderTestPanel,
  OPENAI_PANEL,
  originalProviderTestFetch,
  pendingProviderResponse,
  providerTestButton,
  resetProviderDomTestMocks,
  TEST_PROVIDER_CREDENTIAL,
} from "./provider-dom-test-helpers.tsx";

function mount() {
  const controller = createProviderController(
    OPENAI_PANEL,
    createReactiveState(createProviderViewState([TEST_PROVIDER_CREDENTIAL])),
  );

  const container = mountProviderTestPanel(controller);
  return { container, controller };
}

afterEach(resetProviderDomTestMocks);

test("requires confirmation and reports the exact migrated count", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ migratedSessionCount: 2 }));
  const { container } = mount();
  const trigger = providerTestButton(
    container,
    "Switch sessions to this account",
  );

  trigger.click();
  expectProviderFetchPending(fetch);
  expect(container.querySelector("[role='dialog']")?.textContent).toContain(
    "A running turn keeps the account it already captured",
  );

  providerTestButton(container, "Switch sessions").click();

  await expectTestText(container, "2 sessions switched to this account.");
  expect(fetch).toHaveBeenCalledWith(
    `${providerCredentialSessionReassignmentPath(
      OPENAI_PANEL.credentialsPath,
      TEST_PROVIDER_CREDENTIAL.id,
    )}?workspaceId=global`,
    expect.objectContaining({ body: "{}", method: "POST" }),
  );
});

test("reset closes a pending dialog without restoring stale state", async () => {
  const pending = pendingProviderResponse();
  globalThis.fetch = Object.assign(() => pending.promise, {
    preconnect: originalProviderTestFetch().preconnect,
  });
  const { container, controller } = mount();

  providerTestButton(container, "Switch sessions to this account").click();
  providerTestButton(container, "Switch sessions").click();
  controller.reset();
  pending.resolve(Response.json({ migratedSessionCount: 1 }));
  await Promise.resolve();

  expect(container.querySelector("[role='dialog']")).toBeNull();
  expect(controller.state).toEqual(createProviderViewState(undefined));
});
