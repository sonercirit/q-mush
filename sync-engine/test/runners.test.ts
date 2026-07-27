import { eq } from "drizzle-orm";
import { rmSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { createDatabase } from "../../shared/database.ts";
import { runners } from "../../shared/database/schema.ts";
import { RUNNER_INSTALLER_PATH, RUNNERS_PATH } from "../../shared/routes.ts";
import {
  createPendingRunnerSummary,
  type RunnerSummary,
} from "../../shared/runner-model.ts";
import { readJsonRecord } from "../../sync-engine/oauth.ts";
import { RunnerStore } from "../../sync-engine/runner-store.ts";
import {
  createRunnerIntegration,
  type RunnerIntegration,
} from "../../sync-engine/runners.ts";
import {
  addTestUser,
  createAuthenticatedRequest,
  createAuthenticatedTestContext,
  createAuthenticatedTestDatabase,
  ensureWaveOneColumns,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";
import {
  closeRunnerIntegrationTestSetup,
  createQueuedTestRunnerIntegration,
  createTestRunnerIntegration,
  expectRunnerToken,
  runnerMetadata,
} from "./runner-integration-test-helpers.ts";

const FIRST_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000031";
const SECOND_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000032";
const THIRD_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000033";
const FIRST_TOKEN = "qmr_first-setup-token";
const SECOND_TOKEN = "qmr_second-setup-token";
const THIRD_TOKEN = "qmr_third-setup-token";

class FailingRemovalRunnerStore extends RunnerStore {
  override exists(): boolean {
    return true;
  }

  override remove(): boolean {
    throw new Error("injected removal failure");
  }
}

interface Setup {
  readonly database: ReturnType<typeof createAuthenticatedTestDatabase>;
  readonly integration: RunnerIntegration;
  readonly setNow: (value: number) => void;
}

function createSetup(
  onRemoved?: (userId: string, runnerId: string) => void,
): Setup {
  const ids = [FIRST_RUNNER_ID, SECOND_RUNNER_ID, THIRD_RUNNER_ID];
  const tokens = [
    "first-setup-token",
    "second-setup-token",
    "third-setup-token",
  ];
  const database = createAuthenticatedTestDatabase();
  let now = TEST_NOW;

  const integration = createQueuedTestRunnerIntegration(database, ids, tokens, {
    now: () => now,
    ...(onRemoved === undefined ? {} : { onRemoved }),
  });

  return {
    database,
    integration,
    setNow: (value) => {
      now = value;
    },
  };
}

function createRunner(setup: Setup): Response {
  return setup.integration.collection(
    createAuthenticatedRequest(RUNNERS_PATH, undefined, "POST"),
  );
}

function createRunners(setup: Setup, count: number): void {
  for (let index = 0; index < count; index += 1) {
    createRunner(setup);
  }
}

function setupWithRunners(count: number): Setup {
  const setup = createSetup();
  createRunners(setup, count);
  return setup;
}

function defaultRunnerRequest(runnerId: string): Request {
  return createAuthenticatedRequest(
    `${RUNNERS_PATH}/${runnerId}/default`,
    undefined,
    "POST",
  );
}

function metadata(machineId: string, name = "workstation") {
  return runnerMetadata(machineId, name);
}

function connect(
  setup: Setup,
  token: string,
  machineId: string,
  name?: string,
) {
  return setup.integration.connect(token, metadata(machineId, name));
}

function expectedPendingRunner(id: string): RunnerSummary {
  return createPendingRunnerSummary(id, { isGlobal: true, workspaceIds: [] });
}

function connectedRunner(id: string, name: string): RunnerSummary {
  return {
    architecture: "x64",
    id,
    isDefault: false,
    isGlobal: true,
    lastSeenAt: TEST_NOW,
    name,
    platform: "linux",
    status: "online",
    workspaceIds: [],
  };
}

function runnerOptionQuery(
  offset: number,
  search?: string,
): {
  readonly limit: number;
  readonly offset: number;
  readonly search?: string;
} {
  return {
    limit: 10,
    offset,
    ...(search === undefined ? {} : { search }),
  };
}

function connectFirstRunner(setup: Setup): void {
  createRunner(setup);
  connect(setup, FIRST_TOKEN, "machine-fingerprint-one");
}

async function removeFirstRunner(
  setup: Pick<Setup, "integration">,
): Promise<Response> {
  return setup.integration.remove(
    createAuthenticatedRequest(
      `${RUNNERS_PATH}/${FIRST_RUNNER_ID}`,
      undefined,
      "DELETE",
    ),
    FIRST_RUNNER_ID,
  );
}

async function removeFirstRunnerAndExpect(setup: Setup): Promise<void> {
  expect((await removeFirstRunner(setup)).status).toBe(204);
}

function installerRequest(token: string, download = false): Request {
  const url = new URL(RUNNER_INSTALLER_PATH, "http://localhost:3000");
  url.searchParams.set("token", token);

  if (download) {
    url.searchParams.set("download", "1");
  }

  return new Request(url);
}

function readRunnerList(setup: Setup) {
  return readJsonRecord(
    setup.integration.collection(createAuthenticatedRequest(RUNNERS_PATH)),
    "Invalid runner list",
  );
}

async function expectRunnerListAndClose(
  setup: Setup,
  expected: readonly RunnerSummary[],
): Promise<void> {
  expect(await readRunnerList(setup)).toEqual({ runners: expected });
  setup.database.$client.close();
}

async function readFirstRunnerStatus(response: Response): Promise<unknown> {
  const value = await readJsonRecord(response, "Invalid runner list");
  const runnerList = value["runners"];

  if (!Array.isArray(runnerList)) {
    return undefined;
  }

  const candidates: readonly unknown[] = runnerList;
  const firstRunner = candidates[0];
  return isRecord(firstRunner) ? firstRunner["status"] : undefined;
}

describe("runner setup", () => {
  test("protects a user's runner collection", () => {
    const setup = createSetup();

    expect(
      setup.integration.collection(new Request("http://localhost/api/runners"))
        .status,
    ).toBe(401);
    expect(
      setup.integration.collection(
        new Request("http://localhost/api/runners", { method: "POST" }),
      ).status,
    ).toBe(401);
    setup.database.$client.close();
  });

  test("creates as many pending runner installers as the user needs", async () => {
    const setup = createSetup();
    const firstResponse = createRunner(setup);
    const secondResponse = createRunner(setup);

    expect(firstResponse.status).toBe(201);
    expect(await firstResponse.json()).toEqual({
      runner: expectedPendingRunner(FIRST_RUNNER_ID),
      setup: {
        command: `curl -fsSL 'http://localhost:3000${RUNNER_INSTALLER_PATH}?token=${FIRST_TOKEN}' | sh`,
        downloadUrl: `${RUNNER_INSTALLER_PATH}?token=${FIRST_TOKEN}&download=1`,
      },
    });
    expect(secondResponse.status).toBe(201);

    await expectRunnerListAndClose(setup, [
      expectedPendingRunner(FIRST_RUNNER_ID),
      expectedPendingRunner(SECOND_RUNNER_ID),
    ]);
  });

  test("rejects duplicate plaintext setup tokens before returning an installer", () => {
    const database = createAuthenticatedTestDatabase();
    const integration = createTestRunnerIntegration(database, {
      randomId: (() => {
        const ids = [FIRST_RUNNER_ID, SECOND_RUNNER_ID];
        return () => takeValue(ids, "The test ran out of runner IDs");
      })(),
      randomToken: () => "duplicate-setup-token",
    });
    const request = createAuthenticatedRequest(RUNNERS_PATH, undefined, "POST");

    expect(integration.collection(request).status).toBe(201);
    expect(() => integration.collection(request)).toThrow(
      "runner token is already active",
    );
    const runnerCount = integration.listForUser(TEST_USER_ID).length;
    database.$client.close();
    expect(runnerCount).toBe(1);
  });

  test("rejects a duplicate plaintext token across database connections", () => {
    const path = `/tmp/q-mush-runner-token-${crypto.randomUUID()}.sqlite`;
    const firstDatabase = createDatabase(path);
    const secondDatabase = createDatabase(path);
    ensureWaveOneColumns(firstDatabase);
    ensureWaveOneColumns(secondDatabase);
    addTestUser(firstDatabase, TEST_USER_ID);
    const first = new RunnerStore(firstDatabase, () => FIRST_RUNNER_ID);
    const second = new RunnerStore(secondDatabase, () => SECOND_RUNNER_ID);

    const results = [first, second].map((store) => {
      try {
        store.create(TEST_USER_ID, FIRST_TOKEN, TEST_NOW);
        return "created" as const;
      } catch {
        return "duplicate" as const;
      }
    });

    expect(results.sort()).toEqual(["created", "duplicate"]);
    expect(
      firstDatabase
        .select({ id: runners.id })
        .from(runners)
        .where(eq(runners.isDeleted, false))
        .all(),
    ).toHaveLength(1);
    firstDatabase.$client.close();
    secondDatabase.$client.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  });

  test("sets one owned runner as the user's default", async () => {
    const setup = setupWithRunners(2);

    const responses = [
      setup.integration.setDefault(
        defaultRunnerRequest(FIRST_RUNNER_ID),
        FIRST_RUNNER_ID,
      ),
      setup.integration.setDefault(
        defaultRunnerRequest(SECOND_RUNNER_ID),
        SECOND_RUNNER_ID,
      ),
      setup.integration.setDefault(defaultRunnerRequest("missing"), "missing"),
    ];

    expect(responses.map(({ status }) => status)).toEqual([204, 204, 404]);
    await expectRunnerListAndClose(setup, [
      expectedPendingRunner(FIRST_RUNNER_ID),
      { ...expectedPendingRunner(SECOND_RUNNER_ID), isDefault: true },
    ]);
  });

  test("downloads an installer only for an active setup token", async () => {
    const setup = createSetup();
    createRunner(setup);
    const response = setup.integration.installer(
      installerRequest(FIRST_TOKEN, true),
    );

    expect(response.headers.get("content-disposition")).toEqual(
      'attachment; filename="q-mush-runner-install.sh"',
    );
    expect(response.headers.get("cache-control") === "no-store").toBe(true);
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("http://localhost:3000");
    expect(script).toContain(FIRST_TOKEN);
    expect(script).toContain('RUNNER_FILE="$INSTALL_DIR/q-mush-runner"');
    expect(script).toContain("uname -s");
    expect(script).toContain("chmod 755");
    expect(script).not.toContain("bun.sh/install");
    expect(script).not.toContain("command -v bun");

    expect(
      setup.integration.installer(installerRequest("qmr_unknown")).status,
    ).toBe(404);

    setup.database.$client.close();
  });
});

describe("runner connections", () => {
  function prepareRegistration(setup: Setup, token: string, machineId: string) {
    return setup.integration.preflightRegistration(
      token,
      metadata(machineId, "first"),
    );
  }

  test("connects each setup to one computer and each computer to one runner", async () => {
    const setup = setupWithRunners(2);

    const firstRegistration = connect(
      setup,
      FIRST_TOKEN,
      "machine-fingerprint-one",
    );
    expect(firstRegistration?.connection.id).toBe(FIRST_RUNNER_ID);

    const reusedToken = connect(setup, FIRST_TOKEN, "another-machine");
    expect(reusedToken).toBeUndefined();

    const reinstalledComputer = connect(
      setup,
      SECOND_TOKEN,
      "machine-fingerprint-one",
    );
    expect(reinstalledComputer?.connection.id).toBe(FIRST_RUNNER_ID);

    expectRunnerToken(setup.integration, FIRST_TOKEN, undefined);
    expectRunnerToken(setup.integration, SECOND_TOKEN, SECOND_TOKEN);
    expect(
      setup.integration.runnerIsAvailable(TEST_USER_ID, FIRST_RUNNER_ID),
    ).toBe(true);

    const reusedConnectionToken = connect(
      setup,
      SECOND_TOKEN,
      "another-machine",
    );
    expect(reusedConnectionToken).toBeUndefined();

    createRunner(setup);
    const secondRegistration = connect(
      setup,
      THIRD_TOKEN,
      "machine-fingerprint-two",
      "laptop",
    );
    expect(secondRegistration?.connection.id).toBe(THIRD_RUNNER_ID);

    await expectRunnerListAndClose(setup, [
      connectedRunner(FIRST_RUNNER_ID, "workstation"),
      connectedRunner(THIRD_RUNNER_ID, "laptop"),
    ]);
  });

  test("preflights without rotating a same-machine token", () => {
    const setup = createSetup();
    createRunners(setup, 2);
    expect(
      connect(setup, FIRST_TOKEN, "machine-fingerprint-one")?.connection.id,
    ).toBe(FIRST_RUNNER_ID);

    const proposal = setup.integration.preflightRegistration(
      SECOND_TOKEN,
      metadata("machine-fingerprint-one", "reinstalled"),
    );

    expect(proposal).toMatchObject({
      runnerId: FIRST_RUNNER_ID,
    });

    expectRunnerToken(setup.integration, FIRST_TOKEN, FIRST_TOKEN);
    expect(setup.integration.listForUser(TEST_USER_ID)).toEqual([
      connectedRunner(FIRST_RUNNER_ID, "workstation"),
      expectedPendingRunner(SECOND_RUNNER_ID),
    ]);
    expectRunnerToken(setup.integration, SECOND_TOKEN, SECOND_TOKEN);
    setup.database.$client.close();
  });

  test("fails a stale registration proposal closed", () => {
    const setup = createSetup();
    createRunner(setup);
    const first = prepareRegistration(
      setup,
      FIRST_TOKEN,
      "machine-fingerprint-one",
    );
    const second = prepareRegistration(
      setup,
      FIRST_TOKEN,
      "machine-fingerprint-one",
    );

    expect(first?.prepare().status).toBe("registered");
    expect(second?.prepare()).toEqual({ status: "registration_changed" });

    const retried = prepareRegistration(
      setup,
      FIRST_TOKEN,
      "machine-fingerprint-one",
    );
    expect(retried?.prepare().status).toBe("registered");
    const pendingRunners = setup.integration.listForUser(TEST_USER_ID);
    expect(pendingRunners).toMatchObject([
      { id: FIRST_RUNNER_ID, name: null, status: "pending" },
    ]);

    closeRunnerIntegrationTestSetup(setup);
  });

  test("paginates and searches only online runners", () => {
    const setup = createSetup();
    for (let index = 0; index < 3; index += 1) {
      createRunner(setup);
    }
    connect(setup, FIRST_TOKEN, "machine-fingerprint-one", "Alpha desktop");
    connect(setup, SECOND_TOKEN, "machine-fingerprint-two", "Beta laptop");
    setup.setNow(TEST_NOW + 60_000);
    const third = connect(
      setup,
      THIRD_TOKEN,
      "machine-fingerprint-three",
      "Fresh alpha",
    );
    if (third !== undefined) {
      setup.integration.seen(third.connection);
    }

    expect(
      setup.integration.listOnlineForUser(TEST_USER_ID, runnerOptionQuery(0)),
    ).toEqual({
      items: [
        {
          ...connectedRunner(THIRD_RUNNER_ID, "Fresh alpha"),
          lastSeenAt: TEST_NOW + 60_000,
        },
      ],
      totalItems: 1,
    });
    expect(
      setup.integration.listOnlineForUser(
        TEST_USER_ID,
        runnerOptionQuery(0, "ALPHA"),
      ),
    ).toMatchObject({ items: [{ id: THIRD_RUNNER_ID }], totalItems: 1 });
    expect(
      setup.integration.listOnlineForUser(
        TEST_USER_ID,
        runnerOptionQuery(1, "alpha"),
      ),
    ).toEqual({ items: [], totalItems: 1 });
    setup.database.$client.close();
  });

  test("uses WebSocket activity to report online state", async () => {
    const setup = createSetup();
    connectFirstRunner(setup);
    setup.setNow(TEST_NOW + 30_000);
    const connected = setup.integration.connect(
      FIRST_TOKEN,
      metadata("machine-fingerprint-one"),
    );
    const connection = connected?.connection;
    expect(connection).toBeDefined();

    if (connection !== undefined) {
      setup.integration.seen(connection);
    }

    setup.setNow(TEST_NOW + 60_001);
    const onlineList = setup.integration.collection(
      createAuthenticatedRequest(RUNNERS_PATH),
    );
    expect(await readFirstRunnerStatus(onlineList)).toBe("online");

    setup.setNow(TEST_NOW + 75_001);
    const offlineList = setup.integration.collection(
      createAuthenticatedRequest(RUNNERS_PATH),
    );
    expect(await readFirstRunnerStatus(offlineList)).toBe("offline");

    if (connection !== undefined) {
      setup.setNow(TEST_NOW + 80_000);
      setup.integration.seen(connection);
      const reconnectedList = setup.integration.collection(
        createAuthenticatedRequest(RUNNERS_PATH),
      );
      expect(await readFirstRunnerStatus(reconnectedList)).toBe("online");
      setup.integration.disconnected(connection);
    }
    const disconnectedList = setup.integration.collection(
      createAuthenticatedRequest(RUNNERS_PATH),
    );
    expect(await readFirstRunnerStatus(disconnectedList)).toBe("offline");
    setup.database.$client.close();
  });

  test("notifies the session domain after transactional removal", async () => {
    const removed: string[] = [];
    const setup = createSetup((userId, runnerId) => {
      removed.push(`${userId}:${runnerId}`);
    });
    connectFirstRunner(setup);

    await removeFirstRunnerAndExpect(setup);

    expect(removed).toEqual([`${TEST_USER_ID}:${FIRST_RUNNER_ID}`]);
    setup.database.$client.close();
  });

  test("does not run destructive listeners when the removal transaction fails", async () => {
    const { auth, database } = createAuthenticatedTestContext();
    let removingCalls = 0;
    let removedCalls = 0;
    const integration = createRunnerIntegration(auth, {
      database,
      now: () => TEST_NOW,
      store: new FailingRemovalRunnerStore(database),
    });
    integration.onRemoving(() => {
      removingCalls += 1;
    });
    integration.onRemoved(() => {
      removedCalls += 1;
    });

    await expect(removeFirstRunner({ integration })).rejects.toThrow(
      "injected removal failure",
    );
    expect([removingCalls, removedCalls]).toEqual([0, 0]);
    database.$client.close();
  });

  test("soft deletes a runner and rejects its token", async () => {
    const setup = createSetup();
    connectFirstRunner(setup);

    await removeFirstRunnerAndExpect(setup);
    expectRunnerToken(setup.integration, FIRST_TOKEN, undefined);
    const storedRunner = setup.database.query.runners
      .findFirst({
        columns: { isDeleted: true },
        where: eq(runners.id, FIRST_RUNNER_ID),
      })
      .sync();
    expect(storedRunner?.isDeleted).toBe(true);

    closeRunnerIntegrationTestSetup(setup);
  });
});
