import { describe, expect, test, vi } from "vitest";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import { AttachmentFallbackApi } from "../attachment-fallback-api.ts";

const USER = {
  email: "user@example.test",
  id: "user-1",
  name: "User",
};
const SELECTION = {
  credentialId: "credential-1",
  modality: "image" as const,
  model: "vision-model",
  openRouterProviderTag: null,
  provider: "openai" as const,
};

function setup(validate: () => Promise<boolean>) {
  const set = vi.fn();
  const api = new AttachmentFallbackApi({
    now: () => 2,
    requests: {
      authenticate: (_request, _method, action) => action(USER),
      forUser: (_request, action) => action(USER),
    },
    store: { list: () => [], set },
    validate: () => validate(),
  });
  return { api, set };
}

function selectionRequest(body: object): Request {
  return new Request("http://localhost/api/sessions/attachment-fallbacks", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

describe("attachment fallback API", () => {
  test("rejects legacy global prompts", async () => {
    const { api, set } = setup(() => Promise.resolve(true));
    const response = await api.collection(
      selectionRequest({ ...SELECTION, prompt: "legacy" }),
    );

    expect(response.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  test("rejects a selection unavailable from discovered models", async () => {
    const catalog = testAgentModelCatalog({ id: "other-model" });
    const { api, set } = setup(() =>
      Promise.resolve(catalog.models.some(({ id }) => id === SELECTION.model)),
    );
    const response = await api.collection(selectionRequest(SELECTION));

    expect(response.status).toBe(409);
    expect(set).not.toHaveBeenCalled();
  });
});
