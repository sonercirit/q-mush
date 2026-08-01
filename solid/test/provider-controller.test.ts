import { expect, test } from "vitest";
import {
  GENERIC_CREDENTIALS_PATH,
  OPENAI_CREDENTIALS_PATH,
  connectionScopesPath,
} from "../../shared/routes.ts";
import {
  GENERIC_PANEL,
  OPENAI_PANEL,
  type ProviderPanelConfiguration,
} from "../../solid/provider-client.tsx";
import { ProviderController } from "../../solid/provider-controller.ts";
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
    switch (init?.method) {
      case "POST":
        return Response.json(credential, { status: 201 });
      case "PUT":
        return new Response(null, { status: 204 });
      case undefined:
      default:
        return Response.json({ credentials: [] });
    }
  });
  return { controller: new ProviderController(configuration), requests };
}

test("submits a generic provider base URL, label, and optional key", async () => {
  const { controller, requests } = recordedProvider(
    GENERIC_PANEL,
    createdCredential({
      baseUrl: "http://localhost:11434/v1",
      id: "generic-credential",
      label: "Local Ollama",
    }),
  );

  await controller.add("", "Local Ollama", "http://localhost:11434/v1/");

  expect(requests).toContainEqual({
    body: {
      apiKey: "",
      baseUrl: "http://localhost:11434/v1/",
      label: "Local Ollama",
      workspaceIds: ["global"],
    },
    method: "POST",
    url: GENERIC_CREDENTIALS_PATH,
  });
});

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
