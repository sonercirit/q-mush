import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { isRecord } from "../auth-model.ts";
import { createGoogleAuthFromEnvironment } from "../auth.ts";
import { runners } from "../database/schema.ts";
import { readJsonRecord } from "../oauth.ts";
import {
  RUNNER_HEARTBEAT_PATH,
  RUNNER_INSTALLER_PATH,
  RUNNER_REGISTER_PATH,
  RUNNERS_PATH,
} from "../routes.ts";
import {
  createPendingRunnerSummary,
  type RunnerSummary,
} from "../runner-model.ts";
import { createRunnerIntegration } from "../runners.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  TEST_NOW,
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

function runnerRequest(
  path: string,
  token: string,
  body?: Readonly<Record<string, string>>,
): Request {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const init: RequestInit = { headers, method: "POST" };

  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }

  return new Request(`http://localhost:3000${path}`, init);
}

function createRunner(setup: Setup): Response {
  return setup.integration.collection(
    createAuthenticatedRequest(RUNNERS_PATH, undefined, "POST"),
  );
}

function registrationRequest(
  token: string,
  machineId: string,
  name = "workstation",
): Request {
  return runnerRequest(RUNNER_REGISTER_PATH, token, {
    architecture: "x64",
    machineId,
    name,
    platform: "linux",
  });
}

function connectedRunner(id: string, name: string): RunnerSummary {
  return {
    architecture: "x64",
    id,
    lastSeenAt: TEST_NOW,
    name,
    platform: "linux",
    status: "online",
  };
}

async function connectFirstRunner(setup: Setup): Promise<void> {
  createRunner(setup);
  await setup.integration.register(
    registrationRequest(FIRST_TOKEN, "machine-fingerprint-one"),
  );
}

function heartbeatStatus(setup: Setup, token: string): number {
  return setup.integration.heartbeat(
    runnerRequest(RUNNER_HEARTBEAT_PATH, token),
  ).status;
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

  test("downloads an installer only for an active setup token", async () => {
    const setup = createSetup();
    createRunner(setup);
    const response = setup.integration.installer(
      installerRequest(FIRST_TOKEN, true),
    );

    expect(response.headers.get("content-disposition")).toEqual(
      'attachment; filename="q-mush-runner-install.sh"',
    );
    expect(response.headers.get("cache-control") === "no-store").toBeTrue();
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script).toStartWith("#!/bin/sh\n");
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

    const firstRegistration = await setup.integration.register(
      registrationRequest(FIRST_TOKEN, "machine-fingerprint-one"),
    );
    expect(firstRegistration.status).toBe(201);
    expect(await firstRegistration.json()).toEqual({
      id: FIRST_RUNNER_ID,
    });

    const reusedToken = await setup.integration.register(
      registrationRequest(FIRST_TOKEN, "another-machine"),
    );
    expect(reusedToken.status).toBe(409);
    expect(await reusedToken.json()).toEqual({ error: "token_already_used" });

    const reinstalledComputer = await setup.integration.register(
      registrationRequest(SECOND_TOKEN, "machine-fingerprint-one"),
    );
    expect(reinstalledComputer.status).toBe(201);
    expect(await reinstalledComputer.json()).toEqual({ id: FIRST_RUNNER_ID });
    expect(heartbeatStatus(setup, FIRST_TOKEN)).toBe(401);

    const reusedConnectionToken = await setup.integration.register(
      registrationRequest(SECOND_TOKEN, "another-machine"),
    );
    expect(reusedConnectionToken.status).toBe(409);
    expect(await reusedConnectionToken.json()).toEqual({
      error: "token_already_used",
    });

    createRunner(setup);
    const secondRegistration = await setup.integration.register(
      registrationRequest(THIRD_TOKEN, "machine-fingerprint-two", "laptop"),
    );
    expect(secondRegistration.status).toBe(201);

    await expectRunnerListAndClose(setup, [
      connectedRunner(FIRST_RUNNER_ID, "workstation"),
      connectedRunner(THIRD_RUNNER_ID, "laptop"),
    ]);
  });

  test("uses authenticated heartbeats to report online state", async () => {
    const setup = createSetup();
    await connectFirstRunner(setup);
    setup.setNow(TEST_NOW + 30_000);

    const heartbeat = setup.integration.heartbeat(
      runnerRequest(RUNNER_HEARTBEAT_PATH, FIRST_TOKEN),
    );
    expect(heartbeat.status).toBe(204);

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
    setup.database.$client.close();
  });

  test("soft deletes a runner and rejects its token", async () => {
    const setup = createSetup();
    await connectFirstRunner(setup);

    const response = setup.integration.remove(
      createAuthenticatedRequest(
        `${RUNNERS_PATH}/${FIRST_RUNNER_ID}`,
        undefined,
        "DELETE",
      ),
      FIRST_RUNNER_ID,
    );
    expect(response.status).toBe(204);
    expect(heartbeatStatus(setup, FIRST_TOKEN)).toBe(401);
    expect(
      setup.database
        .select({ isDeleted: runners.isDeleted })
        .from(runners)
        .where(eq(runners.id, FIRST_RUNNER_ID))
        .get()?.isDeleted,
    ).toBeTrue();
    setup.database.$client.close();
  });
});
