import { describe, expect, test } from "vitest";
import { CredentialPoolBalancer } from "../../shared/credential-pool-balancer.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import { AgentModelDiscoveryError } from "../agent-model-discovery.ts";
import { ModelCredentialPool } from "../model-credential-pool.ts";
import { ProviderCredentialRejectionError } from "../provider-error.ts";
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

function createSetup() {
  const database = createAuthenticatedTestDatabase();
  for (const id of [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID]) {
    addTestProviderCredential(database, id);
  }
  const credentials = new Map(
    [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID].map((id) => [
      id,
      createTestProviderCredential(id),
    ]),
  );
  const balancer = new CredentialPoolBalancer();
  const pool = new ModelCredentialPool(
    {
      database,
      readCredential: (_userId, selection) =>
        Promise.resolve(credentials.get(selection.credentialId)),
    },
    balancer,
  );
  return { balancer, database, pool };
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
    const database = createAuthenticatedTestDatabase();
    for (const id of [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID]) {
      addTestProviderCredential(database, id);
    }
    let refreshAvailable = false;
    const pool = new ModelCredentialPool({
      database,
      readCredential: (_userId, selection) => {
        if (!refreshAvailable) return Promise.reject(new TypeError("offline"));
        return Promise.resolve(
          createTestProviderCredential(selection.credentialId, "oauth"),
        );
      },
    });

    await expect(pool.candidates(TEST_USER_ID, SELECTION)).resolves.toEqual([]);
    refreshAvailable = true;
    await expect(
      pool.candidates(TEST_USER_ID, SELECTION),
    ).resolves.toHaveLength(2);
    database.$client.close();
  });

  test("cools down only classified credential loading rejections", async () => {
    const database = createAuthenticatedTestDatabase();
    for (const id of [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID]) {
      addTestProviderCredential(database, id);
    }
    const pool = new ModelCredentialPool({
      database,
      readCredential: (_userId, selection) =>
        selection.credentialId === FIRST_CREDENTIAL_ID
          ? Promise.reject(
              new ProviderCredentialRejectionError("rejected", 402),
            )
          : Promise.resolve(
              createTestProviderCredential(selection.credentialId),
            ),
    });

    await expect(
      pool.candidates(TEST_USER_ID, SELECTION),
    ).resolves.toMatchObject([{ id: SECOND_CREDENTIAL_ID }]);
    await expect(
      pool.candidates(TEST_USER_ID, SELECTION),
    ).resolves.toMatchObject([{ id: SECOND_CREDENTIAL_ID }]);
    database.$client.close();
  });

  test("falls through rejected credentials and skips them during cooldown", async () => {
    const setup = createSetup();
    const first = (await setup.pool.candidates(TEST_USER_ID, SELECTION))[0];
    expect(first?.id).toBe(FIRST_CREDENTIAL_ID);
    expect(
      setup.pool.reject(
        TEST_USER_ID,
        SELECTION,
        FIRST_CREDENTIAL_ID,
        new AgentModelDiscoveryError("rejected", 429),
      ),
    ).toBe(true);

    const next = await setup.pool.candidates(TEST_USER_ID, SELECTION);
    expect(next.map(({ id }) => id)).toEqual([SECOND_CREDENTIAL_ID]);
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
