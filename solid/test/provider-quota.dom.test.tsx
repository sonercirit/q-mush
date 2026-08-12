import { afterEach, expect, test, vi } from "vitest";
import type { ProviderQuotaSnapshot } from "../../shared/provider-quota.ts";
import { providerCredentialQuotaResetPath } from "../../shared/routes.ts";
import { ProviderController } from "../provider-controller.ts";
import { createProviderViewState } from "../provider-credential-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import { expectTestText } from "./dom-test-helpers.ts";
import {
  expectProviderFetchPending,
  mountProviderTestPanel,
  OPENAI_PANEL,
  pendingProviderResponse,
  providerTestButton,
  resetProviderDomTestMocks,
  TEST_PROVIDER_CREDENTIAL,
} from "./provider-dom-test-helpers.tsx";

const QUOTA: ProviderQuotaSnapshot = {
  autoResetThresholdPercent: 1,
  bankedResetCount: 2,
  estimatedExhaustionAt: null,
  remainingPercent: 0.8,
  resetSupported: true,
  resetsAt: Date.now() + 60_000,
  source: "ChatGPT Codex usage windows",
};
afterEach(resetProviderDomTestMocks);

test("requires confirmation before consuming a banked reset and locks double clicks", async () => {
  const pending = pendingProviderResponse();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => pending.promise);
  const controller = new ProviderController(
    OPENAI_PANEL,
    createReactiveState({
      ...createProviderViewState([TEST_PROVIDER_CREDENTIAL]),
      quotas: { [TEST_PROVIDER_CREDENTIAL.id]: QUOTA },
    }),
  );
  const container = mountProviderTestPanel(controller);

  providerTestButton(container, "Consume one banked reset").click();
  expectProviderFetchPending(fetch);
  expect(container.textContent).toContain(
    "changes your OpenAI account and spends one banked reset",
  );

  const confirm = providerTestButton(container, "Confirm reset");
  confirm.click();
  confirm.click();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    providerCredentialQuotaResetPath(
      OPENAI_PANEL.credentialsPath,
      TEST_PROVIDER_CREDENTIAL.id,
    ),
    expect.objectContaining({ method: "POST" }),
  );

  pending.resolve(
    Response.json({
      outcome: "reset",
      quota: { ...QUOTA, bankedResetCount: 1, remainingPercent: 100 },
      replayed: false,
    }),
  );
  await new Promise((available) => setTimeout(available, 0));
  expect(controller.state).toMatchObject({
    quotaNotice: {
      credentialId: TEST_PROVIDER_CREDENTIAL.id,
      outcome: "reset",
    },
  });
  await expectTestText(
    container,
    "One banked reset was consumed and eligible quota windows were reset.",
  );
});
