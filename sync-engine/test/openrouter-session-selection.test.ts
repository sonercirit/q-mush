import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { createdAuditFields } from "../../shared/audit.ts";
import { createCredentialCipher } from "../../shared/credential-cipher.ts";
import {
  agentSessions,
  providerCredentials,
  runners,
} from "../../shared/database/schema.ts";
import {
  SESSION_OPENROUTER_PROVIDERS_PATH,
  SESSIONS_PATH,
} from "../../shared/routes.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import { createOpenRouterIntegrationFromEnvironment } from "../../sync-engine/openrouter.ts";
import {
  createAuthenticatedRequest,
  createTestProviderCredential,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  expectedOpenRouterSessionMetadata,
  openRouterSessionMetadataSelection,
  TEST_OPENROUTER_PROVIDER_CATALOG,
} from "./openrouter-provider-catalog-fixture.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { testModelCatalog } from "./session-continuation-test-helpers.ts";
import {
  connectedSessionSetup,
  CREDENTIAL_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { expectErrorResponse } from "./session-reassignment-race-helpers.ts";

function openRouterRequest(tag?: string): Request {
  return createAuthenticatedRequest(
    `/api/sessions?workspaceId=${TEST_WORKSPACE_ID}`,
    {
      autoCompact: true,
      credentialId: CREDENTIAL_ID,
      executionEnvironment: "bare_metal",
      model: "vendor/model",
      ...(tag === undefined ? {} : { openRouterProviderTag: tag }),
      prompt: "Inspect README.md",
      provider: "openrouter",
      reasoningEffort: "high",
      runnerId: "018bcfe5-6800-7000-8000-000000000061",
      tools: [],
      workingDirectory: "/work/project",
    },
    "POST",
  );
}

async function waitForIdle(setup: ReturnType<typeof connectedSessionSetup>) {
  return waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus("idle"),
  );
}

function scopedSessionRequest(suffix: string): Request {
  return createAuthenticatedRequest(
    `${SESSIONS_PATH}/${SESSION_ID}/${suffix}?workspaceId=${TEST_WORKSPACE_ID}`,
    suffix === "messages" ? { prompt: "Follow up" } : undefined,
    "POST",
  );
}

function closeSessionSetup(
  setup: ReturnType<typeof connectedSessionSetup>,
): void {
  setup.database.$client.close();
}

async function expectCreatedSession(
  setup: ReturnType<typeof connectedSessionSetup>,
  tag?: string,
): Promise<Response> {
  const created = await setup.sessions.collection(openRouterRequest(tag));
  expect(created.status).toBe(201);
  return created;
}

function openRouterCredential(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const credential = createTestProviderCredential(CREDENTIAL_ID, "api_key", {
    accountId: null,
    label: "OpenRouter",
  });
  return { ...credential, ...overrides };
}

function sessionSetupWithOpenRouter(
  model: ScriptedAgentModel,
  providerDiscovery: () => Promise<typeof TEST_OPENROUTER_PROVIDER_CATALOG>,
) {
  return connectedSessionSetup(model, "api_key", undefined, {
    credentials: { openrouter: [openRouterCredential()] },
    providerDiscovery,
  });
}

async function discoverProviders(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<Response> {
  const request = createAuthenticatedRequest(
    `${SESSION_OPENROUTER_PROVIDERS_PATH}?credentialId=${CREDENTIAL_ID}&model=vendor%2Fmodel&workspaceId=${TEST_WORKSPACE_ID}`,
  );
  return setup.sessions.openRouterProviders(request);
}

async function completeAndWait(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<void> {
  await completeAgentFileLookup(setup);
  await waitForIdle(setup);
}

async function requestSessionAction(
  setup: ReturnType<typeof connectedSessionSetup>,
  action: "compact" | "continue" | "messages",
): Promise<void> {
  const response =
    action === "messages"
      ? await setup.sessions.message(scopedSessionRequest(action), SESSION_ID)
      : action === "continue"
        ? await setup.sessions.continue(
            scopedSessionRequest(action),
            SESSION_ID,
          )
        : await setup.sessions.compact(
            scopedSessionRequest(action),
            SESSION_ID,
          );
  expect(response.status).toBe(202);
  await completeAndWait(setup);
}

const SOURCE_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000081";
const TARGET_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000082";
const REASSIGNMENT_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000083";
const CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64url");
const CREDENTIAL_CIPHER = createCredentialCipher(
  CREDENTIAL_KEY,
  "OPENROUTER_CREDENTIAL_KEY",
);

function addReassignmentCredential(
  setup: ReturnType<typeof connectedSessionSetup>,
  id: string,
): void {
  setup.database
    .insert(providerCredentials)
    .values({
      ...createdAuditFields(TEST_USER_ID, TEST_NOW),
      credentialFingerprint: `fingerprint-${id}`,
      encryptedCredential: CREDENTIAL_CIPHER.seal(
        `secret-${id}`,
        `${TEST_USER_ID}:${id}`,
      ),
      id,
      label: id,
      provider: "openrouter",
      source: "api_key",
      userId: TEST_USER_ID,
    })
    .run();
}

function addSelectedSession(
  setup: ReturnType<typeof connectedSessionSetup>,
): void {
  const runner = {
    ...createdAuditFields(TEST_USER_ID, TEST_NOW),
    id: REASSIGNMENT_RUNNER_ID,
    tokenHash: "reassignment-runner-token",
    userId: TEST_USER_ID,
  };
  setup.database.insert(runners).values(runner).run();
  setup.database
    .insert(agentSessions)
    .values({
      ...createdAuditFields(TEST_USER_ID, TEST_NOW),
      id: "openrouter-reassignment-session",
      maxContextTokens: 128_000,
      model: "vendor/model",
      openRouterProviderTag: "together",
      provider: "openrouter",
      providerCredentialId: SOURCE_CREDENTIAL_ID,
      providerPricing: JSON.stringify({ input: 1, output: 2 }),
      runnerId: REASSIGNMENT_RUNNER_ID,
      status: "idle",
      title: "Reassign selected provider",
      userId: TEST_USER_ID,
      workingDirectory: "/workspace",
      workspaceId: TEST_WORKSPACE_ID,
    })
    .run();
}

function selectedSessionRow(setup: ReturnType<typeof connectedSessionSetup>) {
  const query = openRouterSessionMetadataSelection(setup.database);
  return query
    .where(undefined)
    .all()
    .find(({ openRouterProviderTag }) => openRouterProviderTag !== null);
}

describe("OpenRouter provider selection integration", () => {
  test("discovers in scope and persists an explicitly selected provider", async () => {
    const model = new ScriptedAgentModel([{ content: "Done.", toolCalls: [] }]);
    const setup = sessionSetupWithOpenRouter(model, () =>
      Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG),
    );

    const discovery = await discoverProviders(setup);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual(TEST_OPENROUTER_PROVIDER_CATALOG);

    const created = await expectCreatedSession(setup, "together");
    expect(await created.clone().json()).toMatchObject({
      maxContextTokens: 64_000,
      openRouterProviderTag: "together",
      providerPricing: { input: "0.0000002", output: "0.0000008" },
    });
    await completeAndWait(setup);
    expect(setup.selectedOpenRouterProviderTags).toEqual(["together"]);
    closeSessionSetup(setup);
  });

  test("rejects discovery for a credential outside the workspace scope", async () => {
    let discoveryCalls = 0;
    const setup = connectedSessionSetup(
      new ScriptedAgentModel([]),
      "api_key",
      undefined,
      {
        credentials: {
          openrouter: [
            openRouterCredential({
              isGlobal: false,
              label: "Other workspace",
              workspaceIds: ["other-workspace"],
            }),
          ],
        },
        providerDiscovery: () => {
          discoveryCalls += 1;
          return Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG);
        },
      },
    );

    const response = await discoverProviders(setup);

    await expectErrorResponse(response, 409, "credential_unavailable");
    expect(discoveryCalls).toBe(0);
    closeSessionSetup(setup);
  });

  test("preserves selection through follow-ups, continuation, and manual compaction", async () => {
    const setup = sessionSetupWithOpenRouter(
      new ScriptedAgentModel([
        { content: "Initial complete.", toolCalls: [] },
        { content: "Follow-up complete.", toolCalls: [] },
        { content: "Continue complete.", toolCalls: [] },
        { content: "Compacted handoff.", toolCalls: [] },
      ]),
      () => Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG),
    );
    const created = await expectCreatedSession(setup, "together");
    await completeAndWait(setup);

    await requestSessionAction(setup, "messages");
    await requestSessionAction(setup, "continue");
    await requestSessionAction(setup, "compact");

    expect(created.status).toBe(201);
    expect(setup.selectedOpenRouterProviderTags).toEqual(
      Array.from({ length: 5 }, () => "together"),
    );
    closeSessionSetup(setup);
  });

  test("keeps selection on automatic compaction and continuation", async () => {
    const setup = connectedSessionSetup(
      new ScriptedAgentModel([
        {
          content: "Work before compaction.",
          contextTokens: 95_000,
          toolCalls: [],
        },
        { content: "Compacted handoff.", toolCalls: [] },
        {
          content: "Work after compaction.",
          contextTokens: 10_000,
          toolCalls: [],
        },
      ]),
      "api_key",
      () => Promise.resolve(testModelCatalog("vendor/model", "Model")),
      {
        credentials: { openrouter: [openRouterCredential()] },
        providerDiscovery: () =>
          Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG),
      },
    );
    expect(setup.selectedOpenRouterProviderTags).toEqual([]);

    await expectCreatedSession(setup, "together");

    await completeAndWait(setup);

    expect(setup.selectedOpenRouterProviderTags).toEqual([
      "together",
      "together",
    ]);
    closeSessionSetup(setup);
  });

  test("does not gate automatic routing on endpoint discovery", async () => {
    const setup = sessionSetupWithOpenRouter(
      new ScriptedAgentModel([{ content: "Done.", toolCalls: [] }]),
      () => Promise.reject(new Error("offline")),
    );

    const created = await expectCreatedSession(setup);
    expect(await created.clone().json()).toMatchObject({
      openRouterProviderTag: null,
    });
    closeSessionSetup(setup);
  });

  test("revalidates a selected provider before credential reassignment", async () => {
    const discovered: string[] = [];
    const model = new ScriptedAgentModel([]);
    const setup = connectedSessionSetup(model);
    addReassignmentCredential(setup, SOURCE_CREDENTIAL_ID);
    addReassignmentCredential(setup, TARGET_CREDENTIAL_ID);
    addSelectedSession(setup);
    const integration = createOpenRouterIntegrationFromEnvironment(
      { OPENROUTER_CREDENTIAL_KEY: CREDENTIAL_KEY },
      createGoogleAuthFromEnvironment(
        {},
        { database: setup.database, now: () => TEST_NOW },
      ),
      {
        database: setup.database,
        discoverOpenRouterProviders: (_ownerId, credential, modelId) => {
          discovered.push(`${credential.id}:${modelId}`);
          return Promise.resolve(TEST_OPENROUTER_PROVIDER_CATALOG);
        },
      },
    );

    const response = await integration.reassignSessions(
      createAuthenticatedRequest(
        `/api/openrouter/credentials/${TARGET_CREDENTIAL_ID}/session-reassignment?workspaceId=${TEST_WORKSPACE_ID}`,
        { workspaceId: TEST_WORKSPACE_ID },
        "POST",
      ),
      TARGET_CREDENTIAL_ID,
    );

    expect(response.status).toBe(200);
    expect(discovered).toEqual([`${TARGET_CREDENTIAL_ID}:vendor/model`]);
    expect(selectedSessionRow(setup)).toEqual(
      expectedOpenRouterSessionMetadata(TARGET_CREDENTIAL_ID),
    );
    closeSessionSetup(setup);
  });
});
