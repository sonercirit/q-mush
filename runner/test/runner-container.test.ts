import { describe, expect, test } from "vitest";
import {
  RunnerContainerManager,
  type RunnerContainerRun,
} from "../../runner/runner-container.ts";
import {
  observeRunnerRejection,
  requireRunnerError,
} from "./promise-test-helpers.ts";
import {
  recordRunnerProcessCall,
  useTemporaryDirectories,
  type FakeRunnerProcessCall,
} from "./temporary-directories.ts";

type RunnerContainerProcessResult = Awaited<ReturnType<RunnerContainerRun>>;

const workspace = useTemporaryDirectories("q-mush-container-test-");

function successfulResult(standardOutput = ""): RunnerContainerProcessResult {
  return {
    exitCode: 0,
    standardError: "",
    standardOutput,
    termination: undefined,
  };
}

function cleanupCall(identifier: string, executable: string) {
  return processCall(executable, ["rm", "--force", identifier]);
}

function processCall(
  executable: string,
  arguments_: readonly string[],
): FakeRunnerProcessCall {
  return { arguments: arguments_, executable };
}

function fakeRun(
  calls: FakeRunnerProcessCall[],
  result: (arguments_: readonly string[]) => RunnerContainerProcessResult,
): RunnerContainerRun {
  return (executable, arguments_) => {
    recordRunnerProcessCall(calls, executable, arguments_);
    return Promise.resolve(result(arguments_));
  };
}

function fakeManager(
  options: ConstructorParameters<typeof RunnerContainerManager>[0] = {},
): RunnerContainerManager {
  return new RunnerContainerManager({
    environment: {
      Q_MUSH_CONTAINER_IMAGE: "example.test/q-mush:latest",
      Q_MUSH_CONTAINER_RUNTIME: "podman",
    },
    randomName: () => "q-mush-owned-test-container",
    ...options,
  });
}

function resultForCommand(
  start: RunnerContainerProcessResult,
  exec = successfulResult(),
): (arguments_: readonly string[]) => RunnerContainerProcessResult {
  return (arguments_) => {
    switch (arguments_[0]) {
      case "exec":
        return exec;
      case "run":
        return start;
      case undefined:
      default:
        return successfulResult();
    }
  };
}

function fakeContainerManager(
  calls: FakeRunnerProcessCall[],
): RunnerContainerManager {
  return fakeManager({
    run: fakeRun(
      calls,
      resultForCommand(
        successfulResult("container-id-1\n"),
        successfulResult("persistent output"),
      ),
    ),
  });
}

function startingManager(
  calls: FakeRunnerProcessCall[],
  start: RunnerContainerProcessResult,
): RunnerContainerManager {
  return fakeManager({ run: fakeRun(calls, resultForCommand(start)) });
}

interface ManagerErrorSetup {
  readonly calls: FakeRunnerProcessCall[];
  readonly error: Error;
}

async function workspaceWithCalls(): Promise<{
  readonly calls: FakeRunnerProcessCall[];
  readonly root: string;
}> {
  return { calls: [], root: await workspace() };
}

async function failedStart(
  start: RunnerContainerProcessResult,
  sessionId: string,
): Promise<ManagerErrorSetup> {
  const { calls, root } = await workspaceWithCalls();
  const containers = startingManager(calls, start);
  const error = requireRunnerError(
    await observeRunnerRejection(
      containers.executeShell(sessionId, root, "pwd", 5),
    ),
  );
  return { calls, error };
}

function terminatedResult(exitCode = 0): RunnerContainerProcessResult {
  return {
    ...successfulResult(),
    exitCode,
    termination: "stopped",
  };
}

function abortableResult(
  signal: AbortSignal | undefined,
  exitCode = 0,
): Promise<RunnerContainerProcessResult> {
  return new Promise((resolve) => {
    signal?.addEventListener(
      "abort",
      () => {
        resolve(terminatedResult(exitCode));
      },
      { once: true },
    );
  });
}

function configuredManager(
  options: ConstructorParameters<typeof RunnerContainerManager>[0],
): RunnerContainerManager {
  return fakeManager(options);
}

function calledArguments(calls: readonly FakeRunnerProcessCall[]): string[] {
  return calls.flatMap(({ arguments: values }) => values);
}

function expectCleanup(
  calls: readonly FakeRunnerProcessCall[],
  identifier: string,
  executable: string,
): void {
  expect(calls.at(-1)).toEqual(cleanupCall(identifier, executable));
}

function expectOwnedNameCleanup(calls: readonly FakeRunnerProcessCall[]): void {
  expectCleanup(calls, "q-mush-owned-test-container", "podman");
}

interface FakeManagerSetup {
  readonly calls: FakeRunnerProcessCall[];
  readonly containers: RunnerContainerManager;
  readonly root: string;
}

async function fakeContainerSetup(): Promise<FakeManagerSetup> {
  const calls: FakeRunnerProcessCall[] = [];
  return {
    calls,
    containers: fakeContainerManager(calls),
    root: await workspace(),
  };
}

interface CancellationSetup {
  readonly calls: FakeRunnerProcessCall[];
  readonly controller: AbortController;
  readonly execution: Promise<string>;
}

async function cancellationSetup(options: {
  readonly command: string;
  readonly manager: (calls: FakeRunnerProcessCall[]) => RunnerContainerManager;
  readonly sessionId: string;
  readonly timeoutSeconds: number;
}): Promise<CancellationSetup> {
  const calls: FakeRunnerProcessCall[] = [];
  const controller = new AbortController();
  const root = await workspace();
  return {
    calls,
    controller,
    execution: options
      .manager(calls)
      .executeShell(
        options.sessionId,
        root,
        options.command,
        options.timeoutSeconds,
        controller.signal,
      ),
  };
}

async function canceledExecution(
  execution: Promise<string>,
  controller: AbortController,
  wait: Promise<unknown> | number,
): Promise<Error> {
  await (typeof wait === "number" ? Bun.sleep(wait) : wait);
  controller.abort();
  return requireRunnerError(await observeRunnerRejection(execution));
}

interface RecoverySetup {
  readonly calls: FakeRunnerProcessCall[];
  readonly containers: RunnerContainerManager;
  readonly trackingPath: string;
}

async function recoverySetup(
  value: Readonly<Record<string, unknown>>,
): Promise<RecoverySetup> {
  const { calls, root } = await workspaceWithCalls();
  const trackingPath = `${root}/owned-containers.json`;
  await Bun.write(trackingPath, JSON.stringify(value));
  return {
    calls,
    containers: new RunnerContainerManager({
      run: fakeRun(calls, () => successfulResult()),
      trackingPath,
    }),
    trackingPath,
  };
}

async function expectEmptyTracking(path: string): Promise<void> {
  expect(await Bun.file(path).json()).toEqual({});
}

async function expectRecovery(
  value: Readonly<Record<string, unknown>>,
  expectedCalls: readonly FakeRunnerProcessCall[],
): Promise<void> {
  const { calls, containers, trackingPath } = await recoverySetup(value);
  await containers.recoverTracked();
  expect(calls).toEqual(expectedCalls);
  await expectEmptyTracking(trackingPath);
}

function runtimeCallResults(
  calls: FakeRunnerProcessCall[],
  options: {
    readonly runResult: RunnerContainerProcessResult;
    readonly signalExitCode?: number;
    readonly onStart?: (signal: AbortSignal | undefined) => void;
  },
): RunnerContainerRun {
  return (executable, arguments_, processOptions) => {
    recordRunnerProcessCall(calls, executable, arguments_);
    const operation = arguments_[0];
    if (operation === "run") {
      options.onStart?.(processOptions.signal);
      return options.onStart === undefined
        ? Promise.resolve(options.runResult)
        : abortableResult(processOptions.signal, options.signalExitCode);
    }
    if (operation === "exec") {
      return abortableResult(processOptions.signal);
    }
    return Promise.resolve(successfulResult());
  };
}

describe("runner session containers", () => {
  test("creates one hardened container, reuses it, and removes only its tracked ID", async () => {
    const setup = await fakeContainerSetup();
    const { calls, containers, root } = setup;

    await containers.prepare("session-1", root);
    expect(
      await containers.executeShell(
        "session-1",
        root,
        "printf persistent output",
        5,
      ),
    ).toBe("stdout:\npersistent output\nExit code: 0");
    await containers.executeShell("session-1", root, "pwd", 5);
    await containers.cleanupSession("session-1");

    const runCalls = calls.filter(
      ({ arguments: values }) => values[0] === "run",
    );
    const execCalls = calls.filter(
      ({ arguments: values }) => values[0] === "exec",
    );
    expect(runCalls).toHaveLength(1);
    const hardenedArguments = [
      "run",
      "--detach",
      "--rm",
      "--name",
      "q-mush-owned-test-container",
      "--init",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--env",
      "HOME=/tmp/q-mush-home",
      "--env",
      "TMPDIR=/tmp",
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/bin/sh",
      "example.test/q-mush:latest",
    ];
    expect(
      hardenedArguments.every(
        (argument) => runCalls[0]?.arguments.includes(argument) === true,
      ),
    ).toBe(true);
    expect(runCalls[0]?.executable).toBe("podman");
    expect(runCalls[0]?.arguments).toContain(
      `type=bind,source=${root},target=/workspace`,
    );
    if (process.getuid !== undefined && process.getgid !== undefined) {
      expect(runCalls[0]?.arguments).toContain(
        `${String(process.getuid())}:${String(process.getgid())}`,
      );
    }
    expect(execCalls).toHaveLength(2);
    expect(
      execCalls.every(({ arguments: values }) =>
        values.includes("container-id-1"),
      ),
    ).toBe(true);
    expectCleanup(calls, "container-id-1", "podman");
    expect(calledArguments(calls)).not.toContain("prune");
  });

  test("reports a missing configured runtime as unavailable", async () => {
    const root = await workspace();
    const containers = new RunnerContainerManager({
      environment: {
        Q_MUSH_CONTAINER_IMAGE: "local-image",
        Q_MUSH_CONTAINER_RUNTIME: "missing-runtime",
      },
      randomName: () => "q-mush-owned-missing-runtime",
      run: () => Promise.reject(new Error("ENOENT")),
    });

    const error = requireRunnerError(
      await observeRunnerRejection(containers.prepare("session-2", root)),
    );

    expect(error.message).toContain("Container execution is unavailable");
    expect(error.message).toContain("missing-runtime");
  });

  test("cleans its exact tracked name when the configured image cannot start", async () => {
    const { calls, error } = await failedStart(
      {
        ...successfulResult(),
        exitCode: 125,
        standardError: "image not known",
      },
      "session-image",
    );

    expect(error.message).toContain("start the configured image");
    expect(error.message).toContain("image not known");
    expectOwnedNameCleanup(calls);
  });

  test("never treats malformed runtime output as a cleanup option", async () => {
    const { calls, error } = await failedStart(
      successfulResult("--all\n"),
      "session-malformed",
    );

    expect(error.message).toContain("returned no container ID");
    expectOwnedNameCleanup(calls);
    expect(calledArguments(calls)).not.toContain("--all");
  });

  test("does not create a container for an already-canceled command", async () => {
    const { calls, containers, root } = await fakeContainerSetup();
    const controller = new AbortController();
    controller.abort();

    const error = requireRunnerError(
      await observeRunnerRejection(
        containers.executeShell(
          "session-canceled",
          root,
          "printf never",
          5,
          controller.signal,
        ),
      ),
    );

    expect(error.message).toContain("stopped");
    expect(calls).toEqual([]);
  });

  test("cancels container startup and removes its uniquely tracked name", async () => {
    let startupSignal: AbortSignal | undefined;
    let signalStartup: (() => void) | undefined;
    const startup = new Promise<void>((resolve) => {
      signalStartup = resolve;
    });
    const { calls, controller, execution } = await cancellationSetup({
      command: "printf never",
      manager: (managerCalls) =>
        configuredManager({
          randomName: () => "q-mush-owned-starting-container",
          run: runtimeCallResults(managerCalls, {
            onStart: (signal) => {
              startupSignal = signal;
              signalStartup?.();
            },
            runResult: successfulResult(),
            signalExitCode: 143,
          }),
        }),
      sessionId: "session-starting",
      timeoutSeconds: 5,
    });

    const error = await canceledExecution(execution, controller, startup);

    expect(startupSignal).toBe(controller.signal);
    expect(error.message).toContain("stopped");
    expectCleanup(calls, "q-mush-owned-starting-container", "podman");
  });

  test("recovers only durable uniquely tracked containers after interruption", async () => {
    await expectRecovery(
      {
        "session-1": {
          identifier: "tracked-container-id",
          runtime: "podman",
        },
      },
      [cleanupCall("tracked-container-id", "podman")],
    );
  });

  test("ignores option-like identifiers in durable recovery state", async () => {
    await expectRecovery(
      { "session-unsafe": { identifier: "--all", runtime: "podman" } },
      [],
    );
  });

  test("clears an already-absent exact container during recovery", async () => {
    const { calls, trackingPath } = await recoverySetup({
      "session-absent": { identifier: "absent-id", runtime: "podman" },
    });
    const absentCalls: FakeRunnerProcessCall[] = [];
    const absentContainers = new RunnerContainerManager({
      run: fakeRun(absentCalls, () => ({
        ...successfulResult(),
        exitCode: 1,
        standardError: "Error: no such container: absent-id",
      })),
      trackingPath,
    });

    await absentContainers.recoverTracked();

    expect(calls).toEqual([]);
    expect(absentCalls).toEqual([cleanupCall("absent-id", "podman")]);
    await expectEmptyTracking(trackingPath);
  });

  test("waits for exact failed cleanup before a same-session relaunch", async () => {
    const root = await workspace();
    const calls: FakeRunnerProcessCall[] = [];
    let cleanupAttempts = 0;
    const containers = fakeManager({
      run: fakeRun(calls, (arguments_) => {
        if (arguments_[0] === "rm") {
          cleanupAttempts += 1;
          return {
            ...successfulResult(),
            exitCode: cleanupAttempts === 1 ? 1 : 0,
          };
        }
        return resultForCommand(successfulResult("container-id\n"))(arguments_);
      }),
    });

    await containers.prepare("session-retry", root);
    await containers.cleanupSession("session-retry");
    await containers.prepare("session-retry", root);

    expect(calls.map(({ arguments: values }) => values[0])).toEqual([
      "run",
      "rm",
      "rm",
      "run",
    ]);
  });

  test("cancellation removes the session container after stopping its command", async () => {
    const { calls, controller, execution } = await cancellationSetup({
      command: "sleep 60",
      manager: (managerCalls) =>
        configuredManager({
          environment: {
            Q_MUSH_CONTAINER_IMAGE: "local-image",
            Q_MUSH_CONTAINER_RUNTIME: "docker",
          },
          randomName: () => "q-mush-owned-canceled-container",
          run: runtimeCallResults(managerCalls, {
            runResult: successfulResult("canceled-container-id\n"),
          }),
        }),
      sessionId: "session-3",
      timeoutSeconds: 60,
    });

    const error = await canceledExecution(execution, controller, 1);

    expect(error.message).toContain("stopped");
    expectCleanup(calls, "canceled-container-id", "docker");
  });
});
