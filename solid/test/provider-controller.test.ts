import { expect, test } from "vitest";
import {
  GENERIC_CREDENTIALS_PATH,
  OPENAI_CREDENTIALS_PATH,
  connectionScopesPath,
} from "../../shared/routes.ts";
import { GENERIC_PANEL, OPENAI_PANEL } from "../../solid/provider-client.tsx";
import {
  createProviderController,
  type ProviderController,
} from "../../solid/provider-controller.ts";
import type { ProviderPanelConfiguration } from "../../solid/provider-panel-configuration.ts";
import {
  installRecordedFetch,
  restoreFetchAfterEach,
} from "./controller-test-helpers.ts";

restoreFetchAfterEach();

type RecordedRequests = Parameters<typeof installRecordedFetch>[0];

function createdCredential(
  overrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    accountId: null,
    id: "credential-1",
    isDefault: false,
    isGlobal: true,
    label: "Credential",
    source: "api_key",
    workspaceIds: [],
    ...overrides,
  };
}

function recordedProvider(
  configuration: ProviderPanelConfiguration,
  credential: Readonly<Record<string, unknown>>,
): {
  readonly controller: ProviderController;
  readonly requests: RecordedRequests;
} {
  const requests: RecordedRequests = [];
  installRecordedFetch(requests, (init) => {
    const responses = {
      POST: (): Response => Response.json(credential, { status: 201 }),
      PUT: (): Response => new Response(null, { status: 204 }),
    } satisfies Record<string, () => Response>;
    const method = init?.method;
    if (method === "POST") return responses.POST();
    if (method === "PUT") return responses.PUT();
    return Response.json({ credentials: [] });
  });
  return { controller: createProviderController(configuration), requests };
}

async function expectSubmittedGenericCredential(
  addInput: Parameters<ProviderController["add"]>,
  expectedBody: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { controller, requests } = recordedProvider(
    GENERIC_PANEL,
    createdCredential({ id: "generic-credential", ...expectedBody }),
  );

  await controller.add(...addInput);

  expect(requests).toContainEqual({
    body: { ...expectedBody, workspaceIds: ["global"] },
    method: "POST",
    url: GENERIC_CREDENTIALS_PATH,
  });
}

test("submits a generic provider base URL, label, and optional key", () =>
  expectSubmittedGenericCredential(
    ["", "Local Ollama", "http://localhost:11434/v1/"],
    {
      apiKey: "",
      baseUrl: "http://localhost:11434/v1/",
      label: "Local Ollama",
    },
  ));

test("submits the selected generic provider API format", () =>
  expectSubmittedGenericCredential(
    [
      "anthropic-key",
      "Claude proxy",
      "https://anthropic.example.test/v1",
      "anthropic",
    ],
    {
      apiFormat: "anthropic",
      apiKey: "anthropic-key",
      baseUrl: "https://anthropic.example.test/v1",
      label: "Claude proxy",
    },
  ));

test("uses the selected workspace for provider load, creation, and scope updates", async () => {
  const { controller, requests } = recordedProvider(
    OPENAI_PANEL,
    createdCredential({
      accountId: "account-1",
      isGlobal: false,
      label: "Work key",
      workspaceIds: ["workspace/one"],
    }),
  );
  controller.setWorkspace("workspace/one");

  await controller.load();
  requests.length = 0;
  await controller.add("sk-test", "Work key");
  const creationRequests = [...requests];
  requests.length = 0;
  await controller.setScopes("credential-1", ["workspace-two"]);

  expect(creationRequests).toContainEqual({
    body: {
      apiKey: "sk-test",
      workspaceIds: ["workspace/one"],
    },
    method: "POST",
    url: OPENAI_CREDENTIALS_PATH,
  });
  expect(requests).toContainEqual({
    body: { workspaceIds: ["workspace-two"] },
    method: "PUT",
    url: connectionScopesPath(OPENAI_CREDENTIALS_PATH, "credential-1"),
  });
});
