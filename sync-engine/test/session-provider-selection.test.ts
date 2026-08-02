import { describe, expect, test, vi } from "vitest";
import { ProviderCredentialRejectionError } from "../../sync-engine/provider-error.ts";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import { SESSION_OPENROUTER_PROVIDERS_PATH } from "../../shared/routes.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import {
  openRouterProvidersForUser,
  prepareOpenRouterSessionCredentialProviderState,
  sessionMetadata,
} from "../../sync-engine/session-provider-selection.ts";
import { TEST_OPENROUTER_PROVIDER_CATALOG } from "./openrouter-provider-catalog-fixture.ts";
import { openRouterCredential } from "./openrouter-provider-discovery-helpers.ts";

const USER: AuthenticatedUser = {
  email: "owner@example.test",
  id: "owner-1",
  name: "Owner",
};
const SELECTED_INPUT = {
  model: "vendor/model",
  openRouterProviderTag: "together",
  provider: "openrouter" as const,
};

type MetadataInput = Parameters<typeof sessionMetadata>[0]["input"];
type ProviderDiscovery = Parameters<
  typeof sessionMetadata
>[0]["discoverProviders"];

async function metadataWithoutProviderDiscovery(
  input: MetadataInput,
  discoverProviders: ProviderDiscovery,
) {
  return sessionMetadata({
    credential: openRouterCredential(),
    discoverModels: () => Promise.resolve(testAgentModelCatalog()),
    discoverProviders,
    input,
    ownerId: "owner-1",
  });
}

async function expectSuccessfulMetadata(
  input: MetadataInput,
  discoverProviders: ProviderDiscovery,
): Promise<void> {
  await expect(
    metadataWithoutProviderDiscovery(input, discoverProviders),
  ).resolves.toEqual({
    maxContextTokens: 128_000,
    providerPricing: null,
  });
}

function metadataOptions(
  overrides: Partial<Parameters<typeof sessionMetadata>[0]> = {},
): Parameters<typeof sessionMetadata>[0] {
  return {
    credential: openRouterCredential(),
    discoverModels: () => Promise.reject(new Error("unused")),
    discoverProviders: () => Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG),
    input: SELECTED_INPUT,
    ownerId: "owner-1",
    ...overrides,
  };
}

function reassignmentSnapshot(openRouterProviderTag: string | null) {
  return {
    sessions: [
      {
        credentialId: "source-1",
        id: "session-1",
        model: "vendor/model",
        openRouterProviderTag,
      },
    ],
  };
}

function providerRequest(workspaceId?: string): Request {
  return new Request(
    `http://localhost${SESSION_OPENROUTER_PROVIDERS_PATH}?credentialId=credential-1&model=vendor%2Fmodel${workspaceId === undefined ? "" : `&workspaceId=${workspaceId}`}`,
  );
}

function providerDiscovery(
  request: Request,
  withCredential: Parameters<
    typeof openRouterProvidersForUser
  >[0]["withCredential"],
) {
  return openRouterProvidersForUser({
    discover: () => Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG),
    request,
    user: USER,
    withCredential,
  });
}

function metadataWithRecordedDiscovery(calls: unknown[][]) {
  return sessionMetadata(
    metadataOptions({
      discoverProviders: (...parameters) => {
        calls.push(parameters);
        return Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG);
      },
    }),
  );
}

describe("OpenRouter session provider validation", () => {
  test("authorizes discovery in the requested workspace scope", async () => {
    const selections: unknown[] = [];
    const response = await providerDiscovery(
      providerRequest("workspace-1"),
      (_userId, selection, action) => {
        selections.push(selection);
        return Promise.resolve(action(openRouterCredential()));
      },
    );

    expect(response.status).toBe(200);
    expect(selections).toEqual([
      {
        credentialId: "credential-1",
        provider: "openrouter",
        workspaceId: "workspace-1",
      },
    ]);
  });

  test("rejects discovery without a workspace scope", async () => {
    const response = await providerDiscovery(providerRequest(), () =>
      Promise.reject(new Error("must not run")),
    );

    expect(response.status).toBe(400);
  });

  test("prevalidates distinct selected models for credential reassignment", async () => {
    const models: string[] = [];
    const result = await prepareOpenRouterSessionCredentialProviderState({
      credential: openRouterCredential(),
      discover: (_ownerId, _credential, model) => {
        models.push(model);
        return Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG);
      },
      ownerId: "owner-1",
      snapshot: {
        sessions: [
          {
            credentialId: "source-1",
            id: "session-1",
            model: "vendor/model",
            openRouterProviderTag: "together",
          },
          {
            credentialId: "source-2",
            id: "session-2",
            model: "vendor/model",
            openRouterProviderTag: "together",
          },
          {
            credentialId: "source-1",
            id: "session-3",
            model: "vendor/automatic",
            openRouterProviderTag: null,
          },
        ],
      },
    });

    expect(models).toEqual(["vendor/model"]);
    expect(result).toMatchObject({
      preparedProviderState: {
        metadataUpdates: [
          { id: "session-1", maxContextTokens: 64_000 },
          { id: "session-2", maxContextTokens: 64_000 },
        ],
      },
    });
  });

  test("skips routing modes when prevalidating credential reassignment", async () => {
    const discover = vi.fn(() =>
      Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG),
    );

    for (const selection of [
      "q-mush-routing:price",
      "q-mush-routing:order:together",
    ]) {
      await expect(
        prepareOpenRouterSessionCredentialProviderState({
          credential: openRouterCredential(),
          discover,
          ownerId: "owner-1",
          snapshot: reassignmentSnapshot(selection),
        }),
      ).resolves.toMatchObject({
        preparedProviderState: { metadataUpdates: [] },
      });
    }
    expect(discover).not.toHaveBeenCalled();
  });

  test("rejects reassignment when a selected tag is unavailable", async () => {
    await expect(
      prepareOpenRouterSessionCredentialProviderState({
        credential: openRouterCredential(),
        discover: () => Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG),
        ownerId: "owner-1",
        snapshot: reassignmentSnapshot("forged"),
      }),
    ).resolves.toEqual({ error: "provider_unavailable" });
  });

  test("force-validates explicit tags and uses endpoint metadata", async () => {
    const calls: unknown[][] = [];

    await expect(metadataWithRecordedDiscovery(calls)).resolves.toEqual({
      maxContextTokens: 64_000,
      providerPricing: { input: "0.0000002", output: "0.0000008" },
    });
    expect(calls[0]?.[3]).toEqual({ force: true });
  });

  test("distinguishes an unavailable explicit tag from discovery failure", async () => {
    await expect(
      sessionMetadata(
        metadataOptions({
          input: { ...SELECTED_INPUT, openRouterProviderTag: "forged" },
        }),
      ),
    ).resolves.toEqual({ error: "provider_unavailable" });

    await expect(
      sessionMetadata(
        metadataOptions({
          discoverProviders: () => Promise.reject(new Error("unavailable")),
        }),
      ),
    ).resolves.toEqual({ error: "validation_failed" });
  });

  test("propagates tagged-provider credential rejections when requested", async () => {
    const rejection = new ProviderCredentialRejectionError("rejected", 429);
    await expect(
      sessionMetadata(
        metadataOptions({
          discoverProviders: () => Promise.reject(rejection),
          rejectCredentialErrors: true,
        }),
      ),
    ).rejects.toBe(rejection);

    await expect(
      sessionMetadata(
        metadataOptions({
          discoverProviders: () => Promise.reject(rejection),
        }),
      ),
    ).resolves.toEqual({ error: "validation_failed" });
  });

  test("keeps routing modes independent of endpoint discovery", async () => {
    await expectSuccessfulMetadata(
      {
        ...SELECTED_INPUT,
        openRouterProviderTag: "q-mush-routing:latency",
      },
      () => Promise.reject(new Error("must not run")),
    );
  });

  test("keeps automatic routing independent of endpoint discovery", async () => {
    await expectSuccessfulMetadata(
      { ...SELECTED_INPUT, openRouterProviderTag: null },
      () => Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG),
    );
  });
});
