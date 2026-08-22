import { describe, expect, test } from "vitest";
import { CredentialPoolBalancer } from "../../shared/credential-pool-balancer.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import { AgentModelDiscoveryError } from "../agent-model-discovery-fetch.ts";
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

function credentialLoadGate() {
  return {
    entered: Promise.withResolvers<undefined>(),
    release: Promise.withResolvers<undefined>(),
  };
}

function gatedCredentialPool() {
  const database = testDatabase();
  const gate = credentialLoadGate();
  let gated = true;
  const pool = modelPool(database, async (_userId, selection) => {
    if (gated && selection.credentialId === FIRST_CREDENTIAL_ID) {
      gate.entered.resolve(undefined);
      await gate.release.promise;
    }
    return createTestProviderCredential(selection.credentialId);
  });
  return { database, gate, pool, releaseGate: () => (gated = false) };
}

async function cancelGatedCredentialRead(
  gate: ReturnType<typeof credentialLoadGate>,
  pending: Promise<unknown>,
  controller: AbortController,
): Promise<void> {
  await gate.entered.promise;
  const reason = new DOMException("Deadline reached", "AbortError");
  controller.abort(reason);
  gate.release.resolve(undefined);
  await expect(pending).rejects.toBe(reason);
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

  test("propagates cancellation during balanced credential loading", async () => {
    const { database, gate, pool } = gatedCredentialPool();
    const controller = new AbortController();
    const pending = pool.representative(
      TEST_USER_ID,
      SELECTION,
      controller.signal,
    );
    await cancelGatedCredentialRead(gate, pending, controller);
    database.$client.close();
  });

  test("canceled candidate reads do not consume or cool down the reusable pool", async () => {
    const { database, gate, pool, releaseGate } = gatedCredentialPool();
    const controller = new AbortController();
    const pending = pool.candidates(TEST_USER_ID, SELECTION, controller.signal);
    await cancelGatedCredentialRead(gate, pending, controller);
    releaseGate();
    const reusable = await pool.candidates(TEST_USER_ID, SELECTION);
    expect(reusable.map(({ id }) => id).sort()).toEqual(
      [FIRST_CREDENTIAL_ID, SECOND_CREDENTIAL_ID].sort(),
    );
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
