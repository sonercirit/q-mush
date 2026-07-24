import { afterEach, expect, test } from "vitest";
import {
  OPENAI_CREDENTIALS_PATH,
  connectionScopesPath,
} from "../../shared/routes.ts";
import { OPENAI_PANEL } from "../../solid/provider-client.tsx";
import { ProviderController } from "../../solid/provider-controller.ts";
import { installRecordedFetch } from "./controller-test-helpers.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("uses the selected workspace for provider load, creation, and scope updates", async () => {
  const requests: Parameters<typeof installRecordedFetch>[0] = [];
  installRecordedFetch(requests, (init) =>
    init?.method === "POST"
      ? Response.json(
          {
            accountId: "account-1",
            id: "credential-1",
            isDefault: false,
            isGlobal: false,
            label: "Work key",
            source: "api_key",
            workspaceIds: ["workspace/one"],
          },
          { status: 201 },
        )
      : init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : Response.json({ credentials: [] }),
  );
  const controller = new ProviderController(OPENAI_PANEL);
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
