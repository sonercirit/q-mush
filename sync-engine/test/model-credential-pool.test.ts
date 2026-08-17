import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { CredentialPoolBalancer } from "../../shared/credential-pool-balancer.ts";
import { providerCredentials } from "../../shared/database/schema.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import { AgentModelDiscoveryError } from "../agent-model-discovery.ts";
import { ModelCredentialPool } from "../model-credential-pool.ts";
import {
  ProviderCredentialReauthenticationRequiredError,
  ProviderCredentialRejectionError,
} from "../provider-error.ts";
import {
  addTestProviderCredential,
  createAuthenticatedTestDatabase,
  createTestProviderCredential,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  balancedTestCredentialOrder,
  fourBalancedPoolSelections,
} from "./credential-balancing-fixtures.ts";

const FIRST_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000091";
const SECOND_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000092";
const SELECTION = {
  credentialId: balancedCredentialId("openai"),
  provider: "openai" as const,
  workspaceId: TEST_WORKSPACE_ID,
};

function testDatabase() {
  const database = createAuthenticatedTestDatabase();
  for (const id of [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID]) {
    addTestProviderCredential(database, id);
  }
  return database;
}

function modelPool(
  database: ReturnType<typeof createAuthenticatedTestDatabase>,
  readCredential: ConstructorParameters<
    typeof ModelCredentialPool
  >[0]["readCredential"],
  balancer?: CredentialPoolBalancer,
): ModelCredentialPool {
  return new ModelCredentialPool({ database, readCredential }, balancer);
}

function createSetup() {
  const database = testDatabase();
  const credentials = new Map(
    [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID].map((id) => [
      id,
      createTestProviderCredential(id),
    ]),
  );
  const balancer = new CredentialPoolBalancer();
  const pool = modelPool(
    database,
    (_userId, selection) =>
      Promise.resolve(credentials.get(selection.credentialId)),
    balancer,
  );
  return { balancer, database, pool };
}

function expectFirstCandidate(
  candidates: Awaited<ReturnType<ModelCredentialPool["candidates"]>>,
): void {
  expect(candidates.at(0)?.id).toBe(FIRST_CREDENTIAL_ID);
}

function expectedRemainingCredential() {
  return [SECOND_CREDENTIAL_ID];
}

async function remainingCredentialIds(
  pool: ModelCredentialPool,
): Promise<readonly string[]> {
  const candidates = await pool.candidates(TEST_USER_ID, SELECTION);
  return candidates.map((credential) => credential.id);
}

function rejectFirstCredential(
  pool: ModelCredentialPool,
  error:
    AgentModelDiscoveryError | ProviderCredentialReauthenticationRequiredError,
): boolean {
  return pool.reject(TEST_USER_ID, SELECTION, FIRST_CREDENTIAL_ID, error);
}

async function rejectBalancedCredential(
  error:
    AgentModelDiscoveryError | ProviderCredentialReauthenticationRequiredError,
): Promise<ReturnType<typeof createSetup>> {
  const setup = createSetup();
  expectFirstCandidate(await setup.pool.candidates(TEST_USER_ID, SELECTION));
  expect(rejectFirstCredential(setup.pool, error)).toBe(true);
  expect(await remainingCredentialIds(setup.pool)).toEqual(
    expectedRemainingCredential(),
  );
  return setup;
}

describe("model credential pool", () => {
  test("distributes four balanced spawns evenly while explicit selection bypasses", async () => {
    const setup = createSetup();
    const selected = await fourBalancedPoolSelections(
      setup.pool,
      TEST_USER_ID,
      SELECTION,
    );
    expect(selected).toEqual(
      balancedTestCredentialOrder(FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID),
    );

    await expect(
      setup.pool.candidates(TEST_USER_ID, {
        ...SELECTION,
        credentialId: SECOND_CREDENTIAL_ID,
      }),
    ).resolves.toMatchObject([{ id: SECOND_CREDENTIAL_ID }]);
    setup.database.$client.close();
  });

  test("retries transient credential loading immediately after recovery", async () => {
    const database = testDatabase();
    let refreshAvailable = false;
    const pool = modelPool(database, (_userId, selection) => {
      if (!refreshAvailable) return Promise.reject(new TypeError("offline"));
      const credential = createTestProviderCredential(
        selection.credentialId,
        "oauth",
      );
      return Promise.resolve(credential);
    });

    await expect(pool.candidates(TEST_USER_ID, SELECTION)).resolves.toEqual([]);
    refreshAvailable = true;
    await expect(
      pool.candidates(TEST_USER_ID, SELECTION),
    ).resolves.toHaveLength(2);
    database.$client.close();
  });

  test("cools down only classified credential loading rejections", async () => {
    const database = testDatabase();
    const pool = modelPool(database, (_userId, selection) => {
      if (selection.credentialId === FIRST_CREDENTIAL_ID) {
        return Promise.reject(
          new ProviderCredentialRejectionError("rejected", 402),
        );
      }
      const credential = createTestProviderCredential(selection.credentialId);
      return Promise.resolve(credential);
    });

    const firstAttempt = await pool.candidates(TEST_USER_ID, SELECTION);
    const secondAttempt = await pool.candidates(TEST_USER_ID, SELECTION);
    expect([firstAttempt, secondAttempt]).toEqual([
      [expect.objectContaining({ id: SECOND_CREDENTIAL_ID })],
      [expect.objectContaining({ id: SECOND_CREDENTIAL_ID })],
    ]);
    database.$client.close();
  });

  test("falls through a persisted re-login-required balanced member", async () => {
    const database = testDatabase();
    database
      .update(providerCredentials)
      .set({ requiresReauthentication: true })
      .where(eq(providerCredentials.id, FIRST_CREDENTIAL_ID))
      .run();
    const reads: string[] = [];
    const pool = modelPool(database, (_userId, selection) => {
      reads.push(selection.credentialId);
      return Promise.resolve(
        createTestProviderCredential(selection.credentialId),
      );
    });

    expect(await remainingCredentialIds(pool)).toEqual(
      expectedRemainingCredential(),
    );
    expect(reads).toEqual([SECOND_CREDENTIAL_ID]);
    database.$client.close();
  });

  test("falls through a terminally rejected balanced member without looping", async () => {
    const setup = await rejectBalancedCredential(
      new ProviderCredentialReauthenticationRequiredError("OpenAI"),
    );
    setup.database.$client.close();
  });

  test("falls through rejected credentials and skips them during cooldown", async () => {
    const setup = await rejectBalancedCredential(
      new AgentModelDiscoveryError("rejected", 429),
    );
    expect(
      setup.pool.reject(
        TEST_USER_ID,
        { ...SELECTION, credentialId: FIRST_CREDENTIAL_ID },
        FIRST_CREDENTIAL_ID,
        new AgentModelDiscoveryError("rejected", 401),
      ),
    ).toBe(false);
    setup.database.$client.close();
  });
});
