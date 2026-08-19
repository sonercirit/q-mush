import { afterEach, expect, test } from "vitest";
import { ProviderController } from "../provider-controller.ts";
import { createReactiveState } from "../reactive-state.ts";
import { providerViewState } from "./client-state-fixtures.ts";
import {
  mountProviderTestPanel,
  OPENAI_PANEL,
  resetProviderDomTestMocks,
} from "./provider-dom-test-helpers.tsx";

afterEach(resetProviderDomTestMocks);

test("an OpenAI OAuth credential without a verified identity cannot reconnect", () => {
  const controller = new ProviderController(
    OPENAI_PANEL,
    createReactiveState(
      providerViewState([
        {
          accountId: null,
          id: "unverified-openai",
          isDefault: true,
          label: "Unverified OpenAI account",
          requiresReauthentication: true,
          source: "oauth",
        },
      ]),
    ),
  );
  const panel = mountProviderTestPanel(controller);

  expect(panel.textContent).toContain("Remove it, then connect OpenAI again");
  expect(
    [...panel.querySelectorAll("a")].some(
      (link) => link.textContent.trim() === "Reconnect this account",
    ),
  ).toBe(false);
});
