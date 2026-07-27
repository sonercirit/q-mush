import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  RunnerStartupRestart,
  type RunnerUpdateContext,
  updateRunnerIfAvailable,
} from "../../runner/runner-update.ts";
import { RUNNER_EXECUTABLE_SHA256_HEADER } from "../../shared/routes.ts";
import { runnerConnectMessage } from "../../shared/runner-realtime-protocol.ts";

const CURRENT_VERSION = "a".repeat(64);
const NEXT_VERSION = "b".repeat(64);
const RUNNER_TARGET = "bun-linux-x64-baseline";
const UPDATED_EXECUTABLE = new TextEncoder().encode("standalone executable");
const fixtureDirectories = new Set<string>();

interface UpdateFixture {
  readonly configurationPath: string;
  readonly executablePath: string;
}

type UpdateDependencies = NonNullable<
  Parameters<typeof updateRunnerIfAvailable>[1]
>;

interface UpdateFailureOutcome {
  readonly executable: string;
  readonly failure: unknown;
}

interface UpdateSuccessOutcome {
  readonly executable: string;
  readonly updated: boolean;
}

type UpdateOutcome = UpdateFailureOutcome | UpdateSuccessOutcome;

function createFixture(): UpdateFixture {
  const directory = mkdtempSync(join(tmpdir(), "q-mush-runner-update-"));
  const executablePath = join(directory, "q-mush-runner");
  const configurationPath = join(directory, "config");
  fixtureDirectories.add(directory);
  writeFileSync(executablePath, "old executable", { mode: 0o755 });
  writeFileSync(configurationPath, "configuration");
  return { configurationPath, executablePath };
}

function installedExecutable(fixture: UpdateFixture): string {
  return readFileSync(fixture.executablePath, "utf8");
}

function unexpectedCall(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

function unexpectedLaunch(message: string): () => never {
  return unexpectedCall(message);
}

function removeFixtures(): void {
  for (const directory of fixtureDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }

  fixtureDirectories.clear();
}

afterEach(removeFixtures);

function updateContext(fixture: UpdateFixture, restartId?: string) {
  return {
    configurationPath: fixture.configurationPath,
    executablePath: fixture.executablePath,
    ...(restartId === undefined ? {} : { restartId }),
    serverOrigin: "http://localhost:3000",
    target: RUNNER_TARGET,
    version: CURRENT_VERSION,
  };
}

function updateArguments(
  fixture: UpdateFixture,
  restartId?: string,
  activationReceipt?: string,
): readonly string[] {
  const arguments_ = ["--config", fixture.configurationPath];
  if (restartId !== undefined) {
    arguments_.push("--restart-id", restartId);
  }
  if (activationReceipt !== undefined) {
    arguments_.push(
      "--activation-receipt",
      activationReceipt,
      "--activation-receipt-phase",
      "finalized",
    );
  }
  return arguments_;
}

function updateDependencies(
  launch: (
    executablePath: string,
    arguments_: readonly string[],
  ) => void = unexpectedLaunch("The update must not launch"),
) {
  return {
    fetch: () => Promise.resolve(updateResponse()),
    launch,
  };
}

async function launchedUpdateArguments(
  fixture: UpdateFixture,
  context: RunnerUpdateContext = updateContext(fixture),
  dependencies: Omit<UpdateDependencies, "launch"> = updateDependencies(),
): Promise<readonly string[]> {
  let launchedArguments: readonly string[] | undefined;
  await updateRunnerIfAvailable(context, {
    ...dependencies,
    launch: (_path, arguments_) => {
      launchedArguments = arguments_;
    },
  });
  if (launchedArguments === undefined) {
    throw new Error("The runner update was not launched");
  }
  return launchedArguments;
}

async function updateOutcome(
  fixture: UpdateFixture,
  dependencies: UpdateDependencies,
): Promise<UpdateOutcome> {
  try {
    const updated = await updateRunnerIfAvailable(
      updateContext(fixture),
      dependencies,
    );
    return { executable: installedExecutable(fixture), updated };
  } catch (failure) {
    return { executable: installedExecutable(fixture), failure };
  }
}

function failedUpdate(outcome: UpdateOutcome): unknown {
  return "failure" in outcome ? outcome.failure : undefined;
}

function updateFailureMessage(failure: unknown): string {
  if (!(failure instanceof Error)) {
    throw new Error("The runner update did not fail with an error");
  }
  return failure.message;
}

function updateResponse(
  body: Uint8Array<ArrayBuffer> = UPDATED_EXECUTABLE,
): Response {
  const digest = new Bun.CryptoHasher("sha256")
    .update(UPDATED_EXECUTABLE)
    .digest("hex");
  return new Response(new Blob([body]), {
    headers: {
      etag: `"${NEXT_VERSION}"`,
      [RUNNER_EXECUTABLE_SHA256_HEADER]: digest,
    },
  });
}

test("atomically installs and launches an available runner update", async () => {
  const fixture = createFixture();
  const operations: string[] = [];
  let launched:
    | { readonly arguments: readonly string[]; readonly path: string }
    | undefined;
  const updated = await updateRunnerIfAvailable(updateContext(fixture), {
    beforeRestart: () => {
      operations.push("handoff");
      expect(installedExecutable(fixture)).toBe("old executable");
      return Promise.resolve("restart-exact");
    },
    fetch: (request) => {
      expect(request.url).toBe(
        `http://localhost:3000/runner/executable?target=${RUNNER_TARGET}`,
      );
      expect(request.headers.get("if-none-match")).toBe(`"${CURRENT_VERSION}"`);
      return Promise.resolve(updateResponse());
    },
    launch: (path, arguments_) => {
      operations.push("launch");
      launched = { arguments: arguments_, path };
    },
  });

  expect(updated).toBe(true);
  expect(operations).toEqual(["handoff", "launch"]);
  expect(new Uint8Array(readFileSync(fixture.executablePath))).toEqual(
    UPDATED_EXECUTABLE,
  );
  expect(statSync(fixture.executablePath).mode & 0o777).toBe(0o755);
  expect(launched).toEqual({
    arguments: [
      "--config",
      fixture.configurationPath,
      "--restart-id",
      "restart-exact",
    ],
    path: fixture.executablePath,
  });
});

async function receiptUpdateArguments(
  context: (fixture: UpdateFixture) => RunnerUpdateContext,
): Promise<{
  readonly arguments: readonly string[];
  readonly fixture: UpdateFixture;
}> {
  const fixture = createFixture();
  const arguments_ = await launchedUpdateArguments(fixture, context(fixture), {
    fetch: () => Promise.resolve(updateResponse()),
  });
  return { arguments: arguments_, fixture };
}

interface ReceiptUpdateCase {
  readonly activationReceipt: string;
  readonly activationReceiptPhase?: "prepared";
  readonly expected: readonly string[];
  readonly restartId?: string;
}

async function expectReceiptUpdate(
  selectedCase: ReceiptUpdateCase,
): Promise<void> {
  const { arguments: arguments_, fixture } = await receiptUpdateArguments(
    (selected) => ({
      ...updateContext(selected, selectedCase.restartId),
      activationReceipt: selectedCase.activationReceipt,
      ...(selectedCase.activationReceiptPhase === undefined
        ? {}
        : { activationReceiptPhase: selectedCase.activationReceiptPhase }),
    }),
  );
  expect(arguments_).toEqual([
    "--config",
    fixture.configurationPath,
    ...selectedCase.expected,
  ]);
}

function expectOperationalCallback(startupRestart: RunnerStartupRestart): void {
  expect(typeof startupRestart.connection().operational).toBe("function");
}

function expectUpdateFailure(failure: unknown, message: string): void {
  expect(failure).toBeInstanceOf(Error);
  expect(updateFailureMessage(failure)).toContain(message);
}

test("launches an ordinary startup update without restart metadata", async () => {
  const fixture = createFixture();
  let arguments_: readonly string[] = [];

  await updateRunnerIfAvailable(
    updateContext(fixture),
    updateDependencies((_path, launchedArguments) => {
      arguments_ = launchedArguments;
    }),
  );

  expect(arguments_).toEqual(["--config", fixture.configurationPath]);
});

test("forwards a committed activation receipt across a startup update", async () => {
  await expectReceiptUpdate({
    activationReceipt: "restart-inherited",
    expected: [
      "--restart-id",
      "restart-inherited",
      "--activation-receipt",
      "restart-inherited",
      "--activation-receipt-phase",
      "finalized",
    ],
    restartId: "restart-inherited",
  });
});

test("forwards an ordinary prepared activation receipt without restart metadata", async () => {
  await expectReceiptUpdate({
    activationReceipt: "ordinary-prepared",
    activationReceiptPhase: "prepared",
    expected: [
      "--activation-receipt",
      "ordinary-prepared",
      "--activation-receipt-phase",
      "prepared",
    ],
  });
});

function restartIdFromLaunch(arguments_: readonly string[]): string {
  const restartArgument = arguments_.indexOf("--restart-id");
  const restartId = arguments_[restartArgument + 1];
  if (restartArgument < 0 || restartId === undefined) {
    throw new Error("The startup update did not preserve its restart ID");
  }
  return restartId;
}

async function launchStartupUpdate(
  fixture: UpdateFixture,
  restartId: string,
): Promise<readonly string[]> {
  return launchedUpdateArguments(
    fixture,
    {
      ...updateContext(fixture),
      restartId,
    },
    {
      beforeRestart: unexpectedCall(
        "An inherited restart ID must not be generated or replaced",
      ),
      fetch: () => Promise.resolve(updateResponse()),
    },
  );
}

function runnerConnectFrame(restartId?: string): unknown {
  const metadata: Parameters<typeof runnerConnectMessage>[0] = {
    architecture: "x64",
    machineId: "machine-1",
    name: "runner-1",
    platform: "linux",
  };
  const frame: unknown = JSON.parse(
    runnerConnectMessage(
      metadata,
      restartId === undefined ? {} : { restartId },
    ),
  );
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    throw new Error("The runner connect frame was invalid");
  }
  return frame;
}

test("rejects invalid startup restart identities", () => {
  expect(() => new RunnerStartupRestart("")).toThrow(
    "runner restart ID is invalid",
  );
  expect(() => new RunnerStartupRestart("x".repeat(201))).toThrow(
    "runner restart ID is invalid",
  );
});

test("an exact connection consumes only its own finalized receipt", () => {
  const startupRestart = new RunnerStartupRestart("restart-activation");
  const connection = startupRestart.connection();

  connection.finalizeActivation("restart-activation");
  connection.operational("restart-activation");
  expect(startupRestart.restartId).toBeUndefined();
  expect(startupRestart.activationReceipt).toBeUndefined();
  expectOperationalCallback(startupRestart);
});

test("stale or pre-finalized operational acknowledgements cannot consume activation state", () => {
  const startupRestart = new RunnerStartupRestart("restart-operational-fence");
  const connection = startupRestart.connection();

  expect(connection.prepareActivation("prepared-receipt")).toBe(true);
  expect(connection.operational("prepared-receipt")).toBe(false);
  expect(connection.finalizeActivation("finalized-receipt")).toBe(true);
  expect(connection.operational("other-receipt")).toBe(false);
  expect(startupRestart.connection()).toMatchObject({
    activationReceipt: "finalized-receipt",
    activationReceiptPhase: "finalized",
    restartId: "restart-operational-fence",
  });

  expect(connection.operational("finalized-receipt")).toBe(true);
  expect(startupRestart.restartId).toBeUndefined();
});

test("retains a prepared receipt when final acknowledgement is lost", () => {
  const startupRestart = new RunnerStartupRestart("restart-prepared");

  startupRestart.prepareActivation("prepared-receipt");

  expect(startupRestart.connection()).toMatchObject({
    activationReceipt: "prepared-receipt",
    activationReceiptPhase: "prepared",
    restartId: "restart-prepared",
  });
  expect(startupRestart.restartId).toBe("restart-prepared");
});

test("restores a prepared receipt phase across process startup", () => {
  const startupRestart = new RunnerStartupRestart("restart-prepared-startup");

  startupRestart.restoreActivation("prepared-startup", "prepared");

  expect(startupRestart.connection()).toMatchObject({
    activationReceipt: "prepared-startup",
    activationReceiptPhase: "prepared",
    restartId: "restart-prepared-startup",
  });
});

test("consumes an ordinary activation receipt after activation", () => {
  const startupRestart = new RunnerStartupRestart();
  startupRestart.restoreActivation("ordinary-activation");
  const connection = startupRestart.connection();

  expect(connection).toMatchObject({
    activationReceipt: "ordinary-activation",
    activationReceiptPhase: "finalized",
  });
  expect(connection.restartId).toBeUndefined();

  connection.operational("ordinary-activation");
  expectOperationalCallback(startupRestart);
});

test("an older connection cannot consume newer activation state", () => {
  const startupRestart = new RunnerStartupRestart("restart-race");
  const stale = startupRestart.connection();
  startupRestart.prepareActivation("prepared-newer");

  stale.operational("prepared-newer");

  expect(startupRestart.connection()).toMatchObject({
    activationReceipt: "prepared-newer",
    activationReceiptPhase: "prepared",
    restartId: "restart-race",
  });
});

test("preserves a startup restart until committed, then drains with a new ID", async () => {
  const fixture = createFixture();
  const inheritedRestartId = "restart-chain-exact";
  const firstLaunch = await launchStartupUpdate(fixture, inheritedRestartId);
  const secondLaunch = await launchStartupUpdate(
    fixture,
    restartIdFromLaunch(firstLaunch),
  );
  const launches = [firstLaunch, secondLaunch];

  const startupRestart = new RunnerStartupRestart(
    restartIdFromLaunch(secondLaunch),
  );
  const uncommittedConnection = startupRestart.connection();
  const uncommittedFrame = runnerConnectFrame(uncommittedConnection.restartId);
  const concurrentConnection = startupRestart.connection();
  uncommittedConnection.operational("unavailable");
  const concurrentFrame = runnerConnectFrame(concurrentConnection.restartId);
  concurrentConnection.finalizeActivation("restart-chain-receipt");
  concurrentConnection.operational("restart-chain-receipt");
  const postCommitConnection = startupRestart.connection();
  const postCommitFrame = runnerConnectFrame(postCommitConnection.restartId);

  let drainCount = 0;
  const subsequentLaunch = await launchedUpdateArguments(
    fixture,
    updateContext(fixture, startupRestart.restartId),
    {
      beforeRestart: () => {
        drainCount += 1;
        return Promise.resolve("restart-after-ready");
      },
      fetch: () => Promise.resolve(updateResponse()),
    },
  );

  const expectedStartupLaunch = updateArguments(fixture, inheritedRestartId);
  expect(launches).toEqual([expectedStartupLaunch, expectedStartupLaunch]);
  expect(uncommittedFrame).toMatchObject({
    restartId: inheritedRestartId,
    type: "connect",
  });
  expect(concurrentFrame).toMatchObject({
    restartId: inheritedRestartId,
    type: "connect",
  });
  expect(postCommitFrame).toEqual({
    architecture: "x64",
    machineId: "machine-1",
    name: "runner-1",
    platform: "linux",
    type: "connect",
  });
  expect(startupRestart.restartId).toBeUndefined();
  expect(drainCount).toBe(1);
  expect(subsequentLaunch).toEqual(
    updateArguments(fixture, "restart-after-ready"),
  );
});

interface FailedUpdateCase {
  readonly beforeRestart?: UpdateDependencies["beforeRestart"];
  readonly fetch: NonNullable<UpdateDependencies["fetch"]>;
  readonly launchFailure: string;
}

function failedOutcome({
  beforeRestart,
  fetch,
  launchFailure,
}: FailedUpdateCase) {
  return updateOutcome(createFixture(), {
    ...updateDependencies(),
    ...(beforeRestart === undefined ? {} : { beforeRestart }),
    fetch,
    launch: unexpectedLaunch(launchFailure),
  });
}

async function expectFailedUpdate(
  selectedCase: FailedUpdateCase,
): Promise<unknown> {
  const outcome = await failedOutcome(selectedCase);
  expect(outcome.executable).toBe("old executable");
  return failedUpdate(outcome);
}

test("keeps running when the server reports that the runner is current", async () => {
  const outcome = await failedOutcome({
    fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    launchFailure: "A current runner must not restart",
  });

  expect(outcome).toEqual({ executable: "old executable", updated: false });
});

test("does not install or launch when the restart handoff fails", async () => {
  const failure = await expectFailedUpdate({
    beforeRestart: () => Promise.reject(new Error("handoff failed")),
    fetch: () => Promise.resolve(updateResponse()),
    launchFailure: "A failed handoff must not launch",
  });

  expect(failure).toEqual(new Error("handoff failed"));
});

test.each(["not-a-number", "-1", "1.5"])(
  "rejects an update with invalid content length %s",
  async (contentLength) => {
    const failure = await expectFailedUpdate({
      fetch: () => {
        const response = updateResponse();
        response.headers.set("content-length", contentLength);
        return Promise.resolve(response);
      },
      launchFailure: "An invalid-size update must not launch",
    });

    expectUpdateFailure(failure, "invalid size");
  },
);

test("rejects an update whose checksum does not match", async () => {
  const failure = await expectFailedUpdate({
    fetch: () => Promise.resolve(updateResponse(new Uint8Array([1, 2, 3]))),
    launchFailure: "An invalid update must not launch",
  });

  expectUpdateFailure(failure, "checksum");
});
