import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { useSynchronousTemporaryDirectories } from "../../shared/test/temporary-directories.ts";
import {
  RunnerContainerManager,
  type RunnerContainerRun,
} from "../runner-container.ts";
import {
  calledArguments,
  containerOperationRun,
  containerRunResult,
  deferredContainerRun,
  executeContainerShell,
  expectPreparationError,
  type FakeContainerCall,
  finalRemoval,
  processResult,
  recordingContainerRun,
  removalArguments,
  removalCall,
  runResultHandler,
} from "./runner-container-helpers.ts";

const temporaryDirectory = useSynchronousTemporaryDirectories(
  "q-mush-container-test-",
);

type FakeCall = FakeContainerCall;

async function trackedContainers(trackingPath: string): Promise<unknown> {
  const source: unknown = JSON.parse(await Bun.file(trackingPath).text());
  return source;
}

function successfulFake(): {
  readonly calls: FakeCall[];
  readonly run: RunnerContainerRun;
} {
  const calls: FakeCall[] = [];
  let nextContainer = 1;
  return {
    calls,
    run: containerOperationRun(calls, {
      exec: () =>
        Promise.resolve(
          processResult({ standardOutput: "hello from container\n" }),
        ),
      run: (arguments_) =>
        containerRunResult(
          arguments_,
          `container-${String(nextContainer++)}`,
        ) ?? Promise.resolve(processResult()),
    }),
  };
}

async function preparedManager() {
  const fake = successfulFake();
  const manager = new RunnerContainerManager({ run: fake.run });
  await manager.prepare("session-1", temporaryDirectory());
  return { fake, manager };
}

function temporaryTrackingPath(relative = "containers.json"): string {
  return join(temporaryDirectory(), relative);
}

function createTrackingPath(value: unknown): string {
  const path = temporaryTrackingPath();
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("RunnerContainerManager", () => {
  test("defaults to the Arch Linux image", async () => {
    const fake = successfulFake();
    const manager = new RunnerContainerManager({
      environment: {},
      run: fake.run,
    });
    await manager.prepare("session-1", temporaryDirectory());

    expect(fake.calls[0]?.executable).toBe("docker");
    expect(fake.calls[0]?.arguments).toContain("archlinux:latest");
  });

  test("explains architecture mismatches with the image override", async () => {
    const calls: FakeCall[] = [];
    const manager = new RunnerContainerManager({
      run: containerOperationRun(calls, {
        run: () =>
          Promise.resolve(
            processResult({
              exitCode: 125,
              standardError:
                "docker: no matching manifest for linux/arm64 in the manifest list entries",
            }),
          ),
      }),
    });

    await expect(
      manager.prepare("session-1", temporaryDirectory()),
    ).rejects.toThrow("set Q_MUSH_CONTAINER_IMAGE to a compatible image");
  });

  test("starts one root container per session and maps the workspace", async () => {
    const fake = successfulFake();
    const root = temporaryDirectory();
    const manager = new RunnerContainerManager({
      environment: {
        Q_MUSH_CONTAINER_IMAGE: "example/image:latest",
        Q_MUSH_CONTAINER_RUNTIME: "podman",
      },
      randomName: () => "q-mush-test-session",
      run: fake.run,
    });

    const first = await manager.executeShell(
      "session-1",
      root,
      "printf hello",
      12,
    );
    const second = await manager.executeShell("session-1", root, "pwd", 3);

    expect(first).toContain("hello from container");
    expect(second).toContain("Exit code: 0");
    expect(
      fake.calls.filter(({ arguments: args }) => args[0] === "run"),
    ).toHaveLength(1);
    const start = fake.calls[0];
    expect(start).toBeDefined();
    expect(start?.executable).toBe("podman");
    // Full-freedom container: exact argv pins that the agent stays root
    // with default capabilities and network access (no --network/--cap-drop/
    // --security-opt/--user/--env in any spelling) alongside the retained
    // per-session lifecycle flags.
    expect(start?.arguments).toEqual([
      "run",
      "--detach",
      "--rm",
      "--name",
      "q-mush-test-session",
      "--label",
      "dev.q-mush.owner=session",
      "--init",
      "--mount",
      `type=bind,source=${root},target=/workspace`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/bin/sh",
      "example/image:latest",
      "-c",
      "while :; do sleep 3600; done",
    ]);
    const executions = fake.calls.filter(
      ({ arguments: args }) => args[0] === "exec",
    );
    expect(executions).toHaveLength(2);
    expect(executions[0]?.arguments).toEqual([
      "exec",
      "--workdir",
      "/workspace",
      "container-1",
      "/bin/sh",
      "-lc",
      "printf hello",
    ]);
    expect(executions[0]?.timeoutSeconds).toBe(12);
  });

  test("forwards container stdout and stderr through the shell stream", async () => {
    const streamed: unknown[] = [];

    const output = await executeContainerShell({
      command: "printf out; printf err >&2",
      handlers: {
        exec: (_arguments, options) => {
          options.onOutput?.({ channel: "stdout", content: "out" });
          options.onOutput?.({ channel: "stderr", content: "err" });
          return Promise.resolve(
            processResult({ standardError: "err", standardOutput: "out" }),
          );
        },
        run: runResultHandler("container-stream"),
      },
      onOutput: (delta) => streamed.push(delta),
      timeoutSeconds: 3,
      workspace: temporaryDirectory(),
    });

    expect(streamed).toEqual([
      { channel: "stdout", content: "out" },
      { channel: "stderr", content: "err" },
    ]);
    expect(output).toContain("stdout:\nout");
    expect(output).toContain("stderr:\nerr");
  });

  test("rejects a different workspace for an existing session", async () => {
    const { manager } = await preparedManager();

    await expectPreparationError(
      manager,
      temporaryDirectory(),
      "workspace changed",
    );
  });

  test("cleans up only the uniquely tracked container when startup is cancelled", async () => {
    const calls: FakeCall[] = [];
    const controller = new AbortController();
    const run = containerOperationRun(calls, {
      run: () => {
        controller.abort();
        return Promise.resolve(processResult({ termination: "stopped" }));
      },
    });
    const manager = new RunnerContainerManager({
      randomName: () => "q-mush-unique-startup",
      run,
    });

    await expect(
      manager.prepare("session-1", temporaryDirectory(), controller.signal),
    ).rejects.toThrow("runner command was stopped");

    expect(calls.map(({ arguments: args }) => args)).toEqual([
      expect.arrayContaining(["run", "--name", "q-mush-unique-startup"]),
      ["rm", "--force", "q-mush-unique-startup"],
    ]);
  });

  test("cleans up only the tracked session container", async () => {
    const { fake, manager } = await preparedManager();
    await manager.prepare("session-2", temporaryDirectory());

    await manager.cleanupSession("session-1");

    expect(removalArguments(fake.calls)).toEqual([
      ["rm", "--force", "container-1"],
    ]);
  });

  test("recovers only validated durable tracked IDs", async () => {
    const path = createTrackingPath({
      invalid: { identifier: "--all", runtime: "docker" },
      malformed: { identifier: 42, runtime: "docker" },
      valid: { identifier: "container-valid_1", runtime: "podman" },
    });
    const fake = successfulFake();
    const manager = new RunnerContainerManager({
      run: fake.run,
      trackingPath: path,
    });

    await manager.recoverTracked();

    expect(calledArguments(fake.calls)).toEqual([
      removalCall("container-valid_1"),
    ]);
    expect(await trackedContainers(path)).toEqual({});
  });

  test("preserves failed durable cleanup for a later recovery attempt", async () => {
    const trackingPath = temporaryTrackingPath();
    writeFileSync(
      trackingPath,
      JSON.stringify({
        "session-1": { identifier: "container-1", runtime: "docker" },
      }),
    );
    const failedCalls: FakeCall[] = [];
    const failed = new RunnerContainerManager({
      run: recordingContainerRun(failedCalls, () =>
        Promise.resolve(
          processResult({ exitCode: 1, standardError: "daemon unavailable" }),
        ),
      ),
      trackingPath,
    });

    await failed.recoverTracked();
    expect(await trackedContainers(trackingPath)).toEqual({
      "session-1": { identifier: "container-1", runtime: "docker" },
    });

    const successful = successfulFake();
    const retry = new RunnerContainerManager({
      run: successful.run,
      trackingPath,
    });
    await retry.recoverTracked();

    expect(calledArguments(successful.calls)).toEqual([
      removalCall("container-1"),
    ]);
    expect(failedCalls).toHaveLength(1);
  });

  test("reports a clear error when the runtime cannot start", async () => {
    const manager = new RunnerContainerManager({
      environment: { Q_MUSH_CONTAINER_RUNTIME: "missing-runtime" },
      run: () => Promise.reject(new Error("ENOENT")),
    });

    await expectPreparationError(
      manager,
      temporaryDirectory(),
      "Container execution is unavailable: could not start missing-runtime. Install Docker or Podman",
    );
  });

  test("cleans up after a timed out shell to avoid reusing uncertain state", async () => {
    const calls: FakeCall[] = [];
    const output = await executeContainerShell({
      calls,
      command: "sleep 100",
      handlers: {
        exec: () =>
          Promise.resolve(
            processResult({ exitCode: 143, termination: "timed-out" }),
          ),
        run: runResultHandler("container-timeout"),
      },
      timeoutSeconds: 1,
      workspace: temporaryDirectory(),
    });

    expect(output).toContain("Timed out after 1 seconds");
    expect(finalRemoval(calls)).toEqual(removalCall("container-timeout"));
  });

  test("cleanup waits for startup and removes the resulting exact ID", async () => {
    const { calls, run, startup } = deferredContainerRun();
    const manager = new RunnerContainerManager({
      randomName: () => "q-mush-pending",
      run,
    });
    const prepared = manager.prepare("session-1", temporaryDirectory());
    const cleanup = manager.cleanupSession("session-1");
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    startup.resolve(processResult({ standardOutput: "container-started\n" }));
    await prepared;

    await cleanup;

    expect(finalRemoval(calls)).toEqual(removalCall("container-started"));
  });

  test("does not reuse a container cleaned while startup was pending", async () => {
    const { calls, startup } = deferredContainerRun();

    let starts = 0;
    const run = containerOperationRun(calls, {
      run: (arguments_) => {
        starts += 1;
        if (starts === 1) {
          return startup.promise;
        }
        return (
          containerRunResult(arguments_, "container-second") ??
          Promise.resolve(processResult())
        );
      },
    });
    const root = temporaryDirectory();
    const manager = new RunnerContainerManager({
      randomName: () => `q-mush-pending-${String(starts + 1)}`,
      run,
    });
    const first = manager.prepare("session-1", root);
    const cleanup = manager.cleanupSession("session-1");
    const second = manager.prepare("session-1", root);
    await Promise.resolve();

    startup.resolve(processResult({ standardOutput: "container-first\n" }));
    await first;
    await cleanup;
    await second;

    expect(starts).toBe(2);
    expect(removalArguments(calls)).toContainEqual(
      removalCall("container-first"),
    );
  });

  test("treats an already absent tracked container as cleaned", async () => {
    const directory = temporaryDirectory();
    const trackingPath = join(directory, "state", "containers.json");
    mkdirSync(join(directory, "state"));
    writeFileSync(
      trackingPath,
      JSON.stringify({
        session: { identifier: "container-gone", runtime: "docker" },
      }),
    );
    const manager = new RunnerContainerManager({
      run: () =>
        Promise.resolve(
          processResult({
            exitCode: 1,
            standardError: "Error: No such container: container-gone",
          }),
        ),
      trackingPath,
    });

    await manager.recoverTracked();

    expect(await trackedContainers(trackingPath)).toEqual({});
  });

  test("serializes concurrent cleanup for the same session", async () => {
    const { fake, manager } = await preparedManager();

    await Promise.all([
      manager.cleanupSession("session-1"),
      manager.cleanupSession("session-1"),
    ]);

    expect(removalArguments(fake.calls)).toHaveLength(1);
  });
});
