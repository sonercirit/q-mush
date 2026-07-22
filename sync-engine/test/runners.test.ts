import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { runners } from "../../shared/database/schema.ts";
import {
  RUNNER_INSTALLER_PATH,
  RUNNER_REALTIME_PATH,
  RUNNERS_PATH,
} from "../../shared/routes.ts";
import {
  createPendingRunnerSummary,
  type RunnerSummary,
} from "../../shared/runner-model.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import { readJsonRecord } from "../../sync-engine/oauth.ts";
import { createRunnerIntegration } from "../../sync-engine/runners.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  createRunnerRequest,
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

const FIRST_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000031";
const SECOND_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000032";
const THIRD_RUNNER_ID = "018bcfe5-6800-7000-8000-000000000033";
const FIRST_TOKEN = "qmr_first-setup-token";
const SECOND_TOKEN = "qmr_second-setup-token";
const THIRD_TOKEN = "qmr_third-setup-token";

interface Setup {
  readonly database: ReturnType<typeof createAuthenticatedTestDatabase>;
  readonly integration: ReturnType<typeof createRunnerIntegration>;
  readonly setNow: (value: number) => void;
}

function createSetup(): Setup {
  const ids = [FIRST_RUNNER_ID, SECOND_RUNNER_ID, THIRD_RUNNER_ID];
  const tokens = [
    "first-setup-token",
    "second-setup-token",
    "third-setup-token",
  ];
  const database = createAuthenticatedTestDatabase();
  let now = TEST_NOW;
  const integration = createRunnerIntegration(
    createGoogleAuthFromEnvironment({}, { database, now: () => TEST_NOW }),
    {
      database,
      now: () => now,
      randomId: () => takeValue(ids, "The test ran out of runner IDs"),
      randomToken: () => takeValue(tokens, "The test ran out of runner tokens"),
    },
  );

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

function defaultRunnerRequest(runnerId: string): Request {
  return createAuthenticatedRequest(
    `${RUNNERS_PATH}/${runnerId}/default`,
    undefined,
    "POST",
  );
}

function metadata(machineId: string, name = "workstation") {
  return {
    architecture: "x64",
    machineFingerprint: machineId,
    name,
    platform: "linux",
  };
}

function connect(
  setup: Setup,
  token: string,
  machineId: string,
  name?: string,
) {
  return setup.integration.connect(token, metadata(machineId, name));
}

function connectedRunner(id: string, name: string): RunnerSummary {
  return {
    architecture: "x64",
    id,
    isDefault: false,
    lastSeenAt: TEST_NOW,
    name,
    platform: "linux",
    status: "online",
  };
}

function connectFirstRunner(setup: Setup): void {
  createRunner(setup);
  connect(setup, FIRST_TOKEN, "machine-fingerprint-one");
}

function expectRevoked(setup: Setup, token: string): void {
  expect(
    setup.integration.runnerToken(
      createRunnerRequest(RUNNER_REALTIME_PATH, token),
    ),
  ).toBeUndefined();
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
      runner: createPendingRunnerSummary(FIRST_RUNNER_ID),
      setup: {
        command: `curl -fsSL 'http://localhost:3000${RUNNER_INSTALLER_PATH}?token=${FIRST_TOKEN}' | sh`,
        downloadUrl: `${RUNNER_INSTALLER_PATH}?token=${FIRST_TOKEN}&download=1`,
      },
    });
    expect(secondResponse.status).toBe(201);

    await expectRunnerListAndClose(setup, [
      createPendingRunnerSummary(FIRST_RUNNER_ID),
      createPendingRunnerSummary(SECOND_RUNNER_ID),
    ]);
  });

  test("sets one owned runner as the user's default", async () => {
    const setup = createSetup();
    for (let runner = 0; runner < 2; runner += 1) {
      createRunner(setup);
    }

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
      createPendingRunnerSummary(FIRST_RUNNER_ID),
      { ...createPendingRunnerSummary(SECOND_RUNNER_ID), isDefault: true },
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
  test("connects each setup to one computer and each computer to one runner", async () => {
    const setup = createSetup();
    createRunner(setup);
    createRunner(setup);

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
    expectRevoked(setup, FIRST_TOKEN);
    expect(
      setup.integration.runnerToken(
        createRunnerRequest(RUNNER_REALTIME_PATH, SECOND_TOKEN),
      ),
    ).toBe(SECOND_TOKEN);
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

  test("soft deletes a runner and rejects its token", () => {
    const setup = createSetup();
    connectFirstRunner(setup);

    const response = setup.integration.remove(
      createAuthenticatedRequest(
        `${RUNNERS_PATH}/${FIRST_RUNNER_ID}`,
        undefined,
        "DELETE",
      ),
      FIRST_RUNNER_ID,
    );
    expect(response.status).toBe(204);
    expectRevoked(setup, FIRST_TOKEN);
    expect(
      setup.database
        .select({ isDeleted: runners.isDeleted })
        .from(runners)
        .where(eq(runners.id, FIRST_RUNNER_ID))
        .get()?.isDeleted,
    ).toBe(true);
    setup.database.$client.close();
  });
});
