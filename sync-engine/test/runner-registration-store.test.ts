import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { runners, runnerWorkspaces } from "../../shared/database/schema.ts";
import { RUNNERS_PATH } from "../../shared/routes.ts";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import {
  createStoredTokenHash,
  createTokenDigest,
} from "../../sync-engine/runner-token.ts";
import type { RunnerIntegration } from "../../sync-engine/runners.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  ensureWaveOneColumns,
  TEST_NOW,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  closeRunnerIntegrationTestSetup,
  createQueuedTestRunnerIntegration,
  createTestRunnerIntegration,
  expectRunnerToken,
  runnerMetadata,
} from "./runner-integration-test-helpers.ts";

const FIRST_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000031";
const SECOND_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000032";
const SCOPE_ID = "018bcfe5-6800-7000-8000-000000000033";
const FIRST_TOKEN = "qmr_first-setup-token";
const SECOND_TOKEN = "qmr_second-setup-token";
const RESTART_ID = "restart-exact";

interface Setup {
  readonly database: ReturnType<typeof createAuthenticatedTestDatabase>;
  readonly integration: RunnerIntegration;
}

function integration(database: Setup["database"]): Setup["integration"] {
  return createTestRunnerIntegration(database);
}

function createSetup(): Setup {
  const database = createAuthenticatedTestDatabase();
  const ids = [FIRST_RUNNER_ID, SECOND_RUNNER_ID, SCOPE_ID];
  const tokens = ["first-setup-token", "second-setup-token"];
  let nextActivationId = 1;
  return {
    database,
    integration: createQueuedTestRunnerIntegration(database, ids, tokens, {
      generateActivationId: () => `activation-${String(nextActivationId++)}`,
    }),
  };
}

function closeSetup(setup: Setup): void {
  closeRunnerIntegrationTestSetup(setup);
}

function createRunner(setup: Setup): void {
  expect(
    setup.integration.collection(
      createAuthenticatedRequest(RUNNERS_PATH, undefined, "POST"),
    ).status,
  ).toBe(201);
}

type RunnerMetadata = ReturnType<typeof runnerMetadata>;

function prepare(
  setup: Setup,
  token: string,
  runnerMetadata: RunnerMetadata,
  restartId?: string,
) {
  const proposal = setup.integration.preflightRegistration(
    token,
    runnerMetadata,
  );
  const committed = proposal?.prepare(restartId);
  expect(committed?.status).toBe("registered");
  if (proposal === undefined || committed?.status !== "registered") {
    throw new Error("The registration was not prepared");
  }
  return { proposal, receipt: committed.activationReceipt };
}

function expectRegistrationPhase(
  setup: Setup,
  runnerMetadata: RunnerMetadata,
  receipt: string,
  phase: "finalized" | "prepared",
): void {
  expect(registrationState(setup, runnerMetadata, receipt)).toMatchObject({
    phase,
    restartId: undefined,
  });
}

function setDefault(setup: Setup, runnerId = FIRST_RUNNER_ID): void {
  expect(
    setup.integration.setDefault(
      createAuthenticatedRequest(
        `${RUNNERS_PATH}/${runnerId}/default`,
        undefined,
        "POST",
      ),
      runnerId,
    ).status,
  ).toBe(204);
}

function activationGeneration(setup: Setup): number | undefined {
  return activationSnapshot(setup)?.generation;
}

function registrationState(
  setup: Setup,
  runnerMetadata: RunnerMetadata,
  receipt: string,
  token = FIRST_TOKEN,
) {
  return setup.integration.receiptState(token, runnerMetadata, receipt);
}

function finalizeRegistration(prepared: ReturnType<typeof prepare>): void {
  expect(prepared.proposal.finalize(prepared.receipt).status).toBe("activated");
}

function activationSnapshot(setup: Setup) {
  return setup.database
    .select({
      generation: runners.activationGeneration,
      id: runners.activationId,
      metadata: {
        architecture: runners.architecture,
        machineFingerprint: runners.machineFingerprint,
        name: runners.name,
        platform: runners.platform,
      },
      phase: runners.activationPhase,
      tokenDigest: runners.tokenDigest,
      tokenHash: runners.tokenHash,
    })
    .from(runners)
    .where(eq(runners.id, FIRST_RUNNER_ID))
    .get();
}

function legacyRunnerValues(
  id: string,
  tokenDigest: string,
  tokenHash: string,
  machineFingerprint?: string,
) {
  return {
    createdAt: new Date(TEST_NOW),
    createdById: TEST_USER_ID,
    id,
    ...(machineFingerprint === undefined ? {} : { machineFingerprint }),
    tokenDigest,
    tokenHash,
    updatedAt: new Date(TEST_NOW),
    updatedById: TEST_USER_ID,
    userId: TEST_USER_ID,
  };
}

function insertLegacyRunner(
  database: Setup["database"],
  tokenDigest: string,
  tokenHash: string,
  machineFingerprint?: string,
): void {
  database
    .insert(runners)
    .values(
      legacyRunnerValues(
        FIRST_RUNNER_ID,
        tokenDigest,
        tokenHash,
        machineFingerprint,
      ),
    )
    .run();
}

function expectOneRunner(database: Setup["database"]): void {
  expect(database.select({ id: runners.id }).from(runners).all()).toHaveLength(
    1,
  );
}

function storedRunnerToken(database: Setup["database"]) {
  const query = database.query.runners.findFirst({
    columns: { tokenDigest: true, tokenHash: true },
    where: eq(runners.id, FIRST_RUNNER_ID),
  });
  return query.sync();
}

function firstRunnerDigest(database: Setup["database"]): string | undefined {
  return storedRunnerToken(database)?.tokenDigest;
}

function recreatedRegistration(
  setup: Setup,
  runnerMetadata: RunnerMetadata,
  activationId: string,
) {
  const recreated = integration(setup.database);
  return {
    proposal: recreated.preflightRegistration(
      FIRST_TOKEN,
      runnerMetadata,
      activationId,
    ),
    recreated,
  };
}

function expectLifecycleSettlement(
  setup: Setup,
  activationId: string,
  lifecycle: "ordinary" | "restart",
  expected: boolean,
  restartId?: string,
): void {
  expect(
    setup.integration.settleActivationLifecycle(
      activationId,
      lifecycle,
      restartId,
    ),
  ).toBe(expected);
}

function initializedRegistration(restartId?: string) {
  const setup = createSetup();
  createRunner(setup);
  const metadata = runnerMetadata("machine-fingerprint-one");
  const prepared = prepare(setup, FIRST_TOKEN, metadata, restartId);
  return { prepared, runnerMetadata: metadata, setup };
}

function rotateRunnerSetup() {
  const setup = createSetup();
  createRunner(setup);
  expect(
    setup.integration.connect(
      FIRST_TOKEN,
      runnerMetadata("machine-fingerprint-one"),
    )?.connection.id,
  ).toBe(FIRST_RUNNER_ID);
  createRunner(setup);
  return setup;
}

function prepareLegacyDatabase() {
  const database = createAuthenticatedTestDatabase();
  database.$client.run("DROP INDEX runners_active_token_digest_unique");
  return database;
}

describe("runner registration durable state", () => {
  test("setDefault does not invalidate or reclassify prepared and finalized receipts", () => {
    const { prepared, runnerMetadata, setup } = initializedRegistration();
    const preparedGeneration = activationGeneration(setup);

    setDefault(setup);
    expectRegistrationPhase(
      setup,
      runnerMetadata,
      prepared.receipt,
      "prepared",
    );
    expect(activationGeneration(setup)).toBe(preparedGeneration);

    finalizeRegistration(prepared);
    setDefault(setup);
    expectRegistrationPhase(
      setup,
      runnerMetadata,
      prepared.receipt,
      "finalized",
    );

    expect(activationGeneration(setup)).toBe(preparedGeneration);
    closeSetup(setup);
  });

  test("prepared restart receipt survives integration recreation", () => {
    const { prepared, runnerMetadata, setup } =
      initializedRegistration(RESTART_ID);
    const preparedId = prepared.proposal.activationId;

    const { proposal: recoveredProposal, recreated } = recreatedRegistration(
      setup,
      runnerMetadata,
      "caller-guessed-another-activation",
    );
    expect(recoveredProposal?.activationId).toBe(preparedId);
    expect(
      recreated.receiptState(FIRST_TOKEN, runnerMetadata, prepared.receipt),
    ).toMatchObject({
      activationId: preparedId,
      connection: { id: FIRST_RUNNER_ID, userId: TEST_USER_ID },
      lifecycle: "restart",
      phase: "prepared",
      restartId: RESTART_ID,
    });
    closeSetup(setup);
  });

  test("finalized receipt replay touches the exact connection without replacement", () => {
    const { prepared, runnerMetadata, setup } = initializedRegistration();
    finalizeRegistration(prepared);
    setup.integration.disconnected({
      id: FIRST_RUNNER_ID,
      userId: TEST_USER_ID,
    });

    const state = integration(setup.database).receiptState(
      FIRST_TOKEN,
      runnerMetadata,
      prepared.receipt,
    );
    expect(state).toMatchObject({ phase: "finalized" });
    const touched =
      state === undefined
        ? undefined
        : setup.integration.touchFinalizedActivation(
            FIRST_TOKEN,
            runnerMetadata,
            prepared.receipt,
          );
    expect(touched?.connection).toEqual(state?.connection);
    const activationBefore = activationSnapshot(setup);
    expect(
      setup.integration.touchFinalizedActivation(
        FIRST_TOKEN,
        runnerMetadata,
        prepared.receipt,
      )?.connection,
    ).toEqual(state?.connection);

    const { proposal: recoveredProposal } = recreatedRegistration(
      setup,
      runnerMetadata,
      "must-not-prepare-a-new-activation",
    );
    const replay = recoveredProposal?.prepare();
    expect(replay?.status).toBe("registered");
    if (replay?.status === "registered") {
      expect(replay.activationReceipt).toBe(prepared.receipt);
      expect(recoveredProposal?.finalize(replay.activationReceipt).status).toBe(
        "activated",
      );
    }
    expect(activationSnapshot(setup)).toEqual(activationBefore);
    expectOneRunner(setup.database);
    closeSetup(setup);
  });

  test("a prepared durable reservation gates conflicting scope", () => {
    const setup = createSetup();
    createRunner(setup);
    const metadata = runnerMetadata("machine-fingerprint-one", "first");
    const stale = prepare(setup, FIRST_TOKEN, metadata);
    const freshMetadata = runnerMetadata("machine-fingerprint-one", "first");
    const fresh = setup.integration.preflightRegistration(
      FIRST_TOKEN,
      freshMetadata,
    );

    expect(fresh?.prepare(RESTART_ID)).toEqual({
      status: "registration_changed",
    });
    expect(registrationState(setup, metadata, stale.receipt)).toMatchObject({
      phase: "prepared",
    });
    expect(
      registrationState(setup, freshMetadata, stale.receipt),
    ).toMatchObject({ phase: "prepared" });
    finalizeRegistration(stale);
    closeSetup(setup);
  });

  test("receipt classification infers and verifies the exact durable scope", () => {
    const { prepared, runnerMetadata, setup } =
      initializedRegistration(RESTART_ID);

    expect(registrationState(setup, runnerMetadata, prepared.receipt)).toEqual({
      activationId: prepared.proposal.activationId,
      connection: { id: FIRST_RUNNER_ID, userId: TEST_USER_ID },
      lifecycle: "restart",
      lifecycleSettled: false,
      phase: "prepared",
      restartId: RESTART_ID,
    });
    expect(
      registrationState(
        setup,
        { ...runnerMetadata, name: "forged" },
        prepared.receipt,
      ),
    ).toBeUndefined();
    expect(
      registrationState(
        setup,
        runnerMetadata,
        `${prepared.receipt.slice(0, -1)}x`,
      ),
    ).toBeUndefined();
    closeSetup(setup);
  });

  test("a superseded prepared activation fails exact classification and finalization", () => {
    const {
      prepared: stale,
      runnerMetadata,
      setup,
    } = initializedRegistration();

    setup.database
      .update(runners)
      .set({ activationId: "activation-superseding" })
      .where(eq(runners.id, FIRST_RUNNER_ID))
      .run();

    expect(
      setup.integration.receiptState(
        FIRST_TOKEN,
        runnerMetadata,
        stale.receipt,
      ),
    ).toBeUndefined();
    expect(stale.proposal.finalize(stale.receipt)).toEqual({
      status: "registration_changed",
    });
    closeSetup(setup);
  });

  test("settles only the exact finalized lifecycle", () => {
    const { prepared, runnerMetadata, setup } =
      initializedRegistration(RESTART_ID);
    finalizeRegistration(prepared);

    const activationId = prepared.proposal.activationId;
    expectLifecycleSettlement(setup, activationId, "ordinary", false);
    expectLifecycleSettlement(
      setup,
      activationId,
      "restart",
      false,
      "wrong-restart",
    );
    expectLifecycleSettlement(setup, activationId, "restart", true, RESTART_ID);
    expect(
      registrationState(setup, runnerMetadata, prepared.receipt)
        ?.lifecycleSettled,
    ).toBe(true);
    closeSetup(setup);
  });

  test("transfers pending scopes when same-machine registration rotates the active runner", async () => {
    const setup = rotateRunnerSetup();

    expect(
      (
        await setup.integration.setScopes(
          createAuthenticatedRequest(
            `${RUNNERS_PATH}/${SECOND_RUNNER_ID}/scopes`,
            { workspaceIds: [TEST_WORKSPACE_ID] },
            "PUT",
          ),
          SECOND_RUNNER_ID,
        )
      ).status,
    ).toBe(204);
    const prepared = prepare(
      setup,
      SECOND_TOKEN,
      runnerMetadata("machine-fingerprint-one", "rotated"),
    );
    finalizeRegistration(prepared);

    expect(
      setup.database
        .select({ runnerId: runnerWorkspaces.runnerId })
        .from(runnerWorkspaces)
        .where(eq(runnerWorkspaces.isDeleted, false))
        .all(),
    ).toEqual([{ runnerId: FIRST_RUNNER_ID }]);
    expect(
      setup.integration.runnerIsAvailable(
        TEST_USER_ID,
        FIRST_RUNNER_ID,
        TEST_WORKSPACE_ID,
      ),
    ).toBe(true);

    closeSetup(setup);
  });

  test("token rotation is deferred until finalization and remains recoverable", () => {
    const setup = rotateRunnerSetup();
    const rotatedMetadata = runnerMetadata(
      "machine-fingerprint-one",
      "rotated",
    );
    const prepared = prepare(setup, SECOND_TOKEN, rotatedMetadata);

    expectRunnerToken(setup.integration, FIRST_TOKEN, FIRST_TOKEN);
    expectRunnerToken(setup.integration, SECOND_TOKEN, SECOND_TOKEN);
    expect(
      registrationState(setup, rotatedMetadata, prepared.receipt, SECOND_TOKEN),
    ).toMatchObject({ phase: "prepared" });
    finalizeRegistration(prepared);
    expect(
      setup.database
        .select({ id: runners.id, isDeleted: runners.isDeleted })
        .from(runners)
        .orderBy(runners.id)
        .all(),
    ).toEqual([
      { id: FIRST_RUNNER_ID, isDeleted: false },
      { id: SECOND_RUNNER_ID, isDeleted: true },
    ]);

    closeSetup(setup);
  });
});

describe("runner token persistence", () => {
  test("stores randomized hashes with deterministic unique digests", () => {
    const database = createAuthenticatedTestDatabase();
    const first = new RunnerStore(database, () => FIRST_RUNNER_ID);
    const second = new RunnerStore(database, () => SECOND_RUNNER_ID);

    first.create(TEST_USER_ID, FIRST_TOKEN, TEST_NOW);
    expect(() => second.create(TEST_USER_ID, FIRST_TOKEN, TEST_NOW)).toThrow(
      "runner token is already active",
    );
    const stored = storedRunnerToken(database);
    expect(stored?.tokenDigest).toBe(createTokenDigest(FIRST_TOKEN));
    expect(stored?.tokenHash).not.toBe(stored?.tokenDigest);
    expect(createStoredTokenHash(FIRST_TOKEN)).not.toBe(stored?.tokenHash);
    database.$client.close();
  });

  test("rejects a duplicate token whose legacy digest has not been backfilled", () => {
    const database = prepareLegacyDatabase();
    const legacyHash = createTokenDigest(FIRST_TOKEN);
    insertLegacyRunner(database, "", legacyHash);
    database.$client.run(
      "CREATE UNIQUE INDEX runners_active_token_digest_unique ON runners (token_digest) WHERE is_deleted = false AND token_digest <> ''",
    );

    expect(() =>
      new RunnerStore(database, () => SECOND_RUNNER_ID).create(
        TEST_USER_ID,
        FIRST_TOKEN,
        TEST_NOW,
      ),
    ).toThrow("runner token is already active");
    expect(firstRunnerDigest(database)).toBe(legacyHash);
    expectOneRunner(database);
    database.$client.close();
  });

  test("backfills legacy digests before creating active uniqueness", () => {
    const database = prepareLegacyDatabase();
    const legacyDigest = createTokenDigest(FIRST_TOKEN);
    insertLegacyRunner(database, "", legacyDigest);

    ensureWaveOneColumns(database);

    expect(firstRunnerDigest(database)).toBe(legacyDigest);

    expect(() => {
      database
        .insert(runners)
        .values(
          legacyRunnerValues(
            SECOND_RUNNER_ID,
            legacyDigest,
            createTokenDigest(SECOND_TOKEN),
          ),
        )
        .run();
    }).toThrow("UNIQUE constraint failed");
    database.$client.close();
  });

  test("authenticates a legacy digest row after digest backfill", () => {
    const database = createAuthenticatedTestDatabase();
    const legacyDigest = createTokenDigest(FIRST_TOKEN);
    insertLegacyRunner(
      database,
      legacyDigest,
      legacyDigest,
      "machine-fingerprint-one",
    );

    expect(new RunnerStore(database).authenticate(FIRST_TOKEN)).toEqual({
      id: FIRST_RUNNER_ID,
      userId: TEST_USER_ID,
    });
    database.$client.close();
  });
});
