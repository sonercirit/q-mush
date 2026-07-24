import { createRoot } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type { OpenRouterProviderCatalog } from "../../shared/agent-configuration.ts";
import { SESSION_OPENROUTER_PROVIDERS_PATH } from "../../shared/routes.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { RevisionState } from "../../solid/revision-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { SessionProviderController } from "../../solid/session-provider-controller.ts";
import {
  installTestFetch,
  requestUrl,
  restoreTestFetch,
} from "./controller-test-helpers.ts";
import { sessionViewWithDraft } from "./session-client-render-fixtures.tsx";

const PROVIDER = {
  contextWindow: 64_000,
  name: "Together",
  pricing: null,
  tag: "together",
} as const;
const CATALOG: OpenRouterProviderCatalog = { providers: [PROVIDER] };
const CREDENTIAL = "openrouter:credential-1";
const MODEL = "vendor/model";

afterEach(restoreTestFetch);

function selectedState(): SessionViewState {
  return sessionViewWithDraft({
    credential: CREDENTIAL,
    model: MODEL,
    openRouterProviderTag: "old-provider",
  });
}

function setup() {
  const reactive = createReactiveState(selectedState());
  const state = new RevisionState(reactive.state, reactive.setState);
  return {
    controller: createRoot(() => new SessionProviderController(state)),
    state,
  };
}

function deferredCatalogs(): {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly resolve: (model: string, catalog: OpenRouterProviderCatalog) => void;
} {
  const pending = new Map<string, (response: Response) => void>();
  return {
    fetch: (request) =>
      new Promise((resolve) => {
        pending.set(
          new URL(request.url).searchParams.get("model") ?? "",
          resolve,
        );
      }),
    resolve: (model, catalog) => {
      pending.get(model)?.(Response.json(catalog));
    },
  };
}

function installFetch(
  implementation: (request: Request) => Promise<Response>,
): void {
  installTestFetch((input) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(String(input), "http://localhost"));
    return implementation(request);
  });
}

function expectAutomaticRouting(state: RevisionState<SessionViewState>): void {
  expect(state.value.draft.openRouterProviderTag).toBe("");
}

function startDiscovery(
  controller: SessionProviderController,
  model = MODEL,
  force = false,
): void {
  controller.ensure(CREDENTIAL, model, force);
}

async function waitForCatalog(
  state: RevisionState<SessionViewState>,
  catalog: OpenRouterProviderCatalog,
): Promise<void> {
  await vi.waitFor(() => {
    expect(state.value.providerDiscovery.catalog).toEqual(catalog);
  });
}

test("discovers providers for the selected credential and model", async () => {
  const requests: Request[] = [];
  installFetch((request) => {
    requests.push(request);
    return Promise.resolve(Response.json(CATALOG));
  });
  const { controller, state } = setup();

  startDiscovery(controller);
  expectAutomaticRouting(state);
  expect(state.value.providerDiscovery.loading).toBe(true);
  await waitForCatalog(state, CATALOG);

  const requestUrlValue = requestUrl(requests[0] ?? "");
  const url = new URL(requestUrlValue);
  expect(url.pathname + url.search).toBe(
    `${SESSION_OPENROUTER_PROVIDERS_PATH}?credentialId=credential-1&model=vendor%2Fmodel`,
  );
});

test("ignores stale discovery responses after the model changes", async () => {
  const pending = deferredCatalogs();
  installFetch(pending.fetch);
  const { controller, state } = setup();

  startDiscovery(controller);
  state.patch({ draft: { ...state.value.draft, model: "vendor/other" } });
  startDiscovery(controller, "vendor/other");
  pending.resolve(MODEL, CATALOG);
  await Promise.resolve();
  expect(state.value.providerDiscovery.catalog).toBeUndefined();

  const otherCatalog: OpenRouterProviderCatalog = {
    providers: [
      { contextWindow: null, name: "Other", pricing: null, tag: "other" },
    ],
  };
  pending.resolve("vendor/other", otherCatalog);
  await waitForCatalog(state, otherCatalog);
});

test("keeps automatic routing available on empty and failed discovery", async () => {
  let fail = false;
  installFetch(() =>
    Promise.resolve(
      fail
        ? new Response(null, { status: 502 })
        : Response.json({ providers: [] }),
    ),
  );
  const { controller, state } = setup();

  startDiscovery(controller);
  await waitForCatalog(state, { providers: [] });
  expectAutomaticRouting(state);

  fail = true;
  startDiscovery(controller, MODEL, true);
  await vi.waitFor(() => {
    expect(state.value.providerDiscovery.error).toBe(
      "Serving-provider discovery failed",
    );
  });
  expectAutomaticRouting(state);
});

test("clears provider state when switching to OpenAI", async () => {
  installFetch(() => Promise.resolve(Response.json(CATALOG)));
  const selected = setup();
  const { controller, state } = selected;
  startDiscovery(controller);
  await waitForCatalog(state, CATALOG);
  state.patch({
    draft: Object.assign({}, state.value.draft, {
      credential: "openai:credential-2",
      openRouterProviderTag: "together",
    }),
  });

  controller.ensure("openai:credential-2", "gpt-4.1-mini");

  expect(state.value.providerDiscovery.key).toBeUndefined();
  expectAutomaticRouting(state);
});
