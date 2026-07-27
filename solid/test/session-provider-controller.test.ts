import { createRoot } from "solid-js";
import { expect, test, vi } from "vitest";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { RevisionState } from "../../solid/revision-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { SessionProviderController } from "../../solid/session-provider-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import { restoreFetchAfterEach } from "./controller-test-helpers.ts";

function selectedState(): SessionViewState {
  const state = initialSessionViewState();
  return {
    ...state,
    draft: {
      ...state.draft,
      credential: "openrouter:credential-1",
      model: "vendor/model",
    },
  };
}

restoreFetchAfterEach();

test("scopes discovery and reports malformed successful catalogs", async () => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(Response.json({ providers: "invalid" }));
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const reactive = createReactiveState(selectedState());
  const state = new RevisionState(reactive.state, reactive.setState);
  const controller = createRoot(() => new SessionProviderController(state));
  controller.setWorkspace("workspace-1");

  controller.ensure("openrouter:credential-1", "vendor/model");

  await vi.waitFor(() => {
    expect(state.value.providerDiscovery.error).toBe(
      "Serving-provider discovery failed",
    );
  });
  expect(requests[0]).toContain("workspaceId=workspace-1");
});
