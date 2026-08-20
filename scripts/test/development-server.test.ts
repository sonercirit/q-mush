import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  startDevelopmentServer,
  triggerDevelopmentRestart,
  type DevelopmentServer,
} from "../development-server.ts";
import { createDevelopmentShutdown } from "../development-shutdown.ts";
import { withTemporaryDirectory } from "./temporary-directory.ts";

async function readStartCount(pathname: string): Promise<number> {
  const file = Bun.file(pathname);

  if (!(await file.exists())) {
    return 0;
  }

  return (await file.text()).split("started\n").length - 1;
}

async function waitForStartCount(
  pathname: string,
  expected: number,
): Promise<void> {
  await expect
    .poll(() => readStartCount(pathname), {
      interval: 10,
      timeout: 5_000,
    })
    .toBeGreaterThanOrEqual(expected);
}

async function waitForFile(pathname: string): Promise<void> {
  await expect
    .poll(() => Bun.file(pathname).exists(), { interval: 10, timeout: 5_000 })
    .toBe(true);
}

async function waitForJson(pathname: string): Promise<unknown> {
  let payload: unknown;
  await expect
    .poll(
      async () => {
        try {
          payload = await Bun.file(pathname).json();
          return true;
        } catch {
          return false;
        }
      },
      { interval: 10, timeout: 5_000 },
    )
    .toBe(true);
  return payload;
}

async function expectStableStartCount(
  pathname: string,
  expected: number,
): Promise<void> {
  await Bun.sleep(100);
  expect(await readStartCount(pathname)).toBe(expected);
}

async function stoppedWithin(
  server: DevelopmentServer,
  minimumMilliseconds: number,
): Promise<number> {
  const startedAt = performance.now();
  await server.stop();
  const elapsedMilliseconds = performance.now() - startedAt;
  expect(elapsedMilliseconds).toBeGreaterThanOrEqual(minimumMilliseconds);
  expect(elapsedMilliseconds).toBeLessThan(1_000);
  return elapsedMilliseconds;
}

function shutdownServerOptions(
  directory: string,
  triggerPath: string,
  command: readonly string[],
  overrides: Readonly<
    Partial<{
      shutdownForceMilliseconds: number;
      shutdownGraceMilliseconds: number;
      shutdownPreparationMilliseconds: number;
    }>
  > = {},
) {
  return {
    command,
    cwd: directory,
    restartTriggerPath: triggerPath,
    shutdownForceMilliseconds: 200,
    shutdownGraceMilliseconds: 80,
    shutdownPreparationMilliseconds: 500,
    ...overrides,
  };
}

async function useDevelopmentServer(
  prefix: string,
  run: (directory: string, triggerPath: string) => Promise<void>,
): Promise<void> {
  await withTemporaryDirectory(prefix, async (directory) => {
    const triggerPath = join(directory, "restart.trigger");
    await Bun.write(triggerPath, "");
    await run(directory, triggerPath);
  });
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  const opened = Promise.withResolvers<undefined>();
  socket.onopen = () => {
    opened.resolve(undefined);
  };
  socket.onerror = () => {
    opened.reject(new Error(`Could not open fixture socket ${url}`));
  };
  await opened.promise;
  socket.onopen = null;
  socket.onerror = null;
  return socket;
}

test("keeps changed source running until the restart trigger changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "q-mush-dev-test-"));
  const sourceDirectory = join(directory, "src");
  const childPath = join(directory, "child.ts");
  const startsPath = join(directory, "starts.txt");
  const triggerPath = join(directory, "restart.trigger");
  let server: DevelopmentServer | undefined;

  try {
    await mkdir(sourceDirectory);
    await Bun.write(triggerPath, "");
    await Bun.write(
      childPath,
      `import { appendFileSync } from "node:fs";
const startsPath = process.argv[2];
if (startsPath === undefined) throw new Error("Missing starts path");
appendFileSync(startsPath, "started\\n");
await new Promise(() => {});
`,
    );
    server = startDevelopmentServer({
      command: [process.execPath, childPath, startsPath],
      cwd: directory,
      restartDelayMilliseconds: 20,
      restartTriggerPath: triggerPath,
    });

    await waitForStartCount(startsPath, 1);
    await Bun.write(join(sourceDirectory, "client.tsx"), "changed\n");
    await expectStableStartCount(startsPath, 1);

    await triggerDevelopmentRestart(triggerPath);
    await waitForStartCount(startsPath, 2);
    await expectStableStartCount(startsPath, 2);
  } finally {
    await server?.stop();
    await rm(directory, { force: true, recursive: true });
  }
});

test("bounds shutdown and force-closes active server resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "q-mush-dev-stop-test-"));
  const childPath = join(directory, "child.ts");
  const serverPath = join(directory, "server.json");
  const pendingPath = join(directory, "pending.txt");
  const reportPath = join(directory, "shutdown.json");
  const triggerPath = join(directory, "restart.trigger");
  const sockets: WebSocket[] = [];
  let pendingRequest: Promise<unknown> | undefined;
  let server: DevelopmentServer | undefined;

  try {
    await Bun.write(triggerPath, "");
    await Bun.write(
      childPath,
      `import { writeFileSync } from "node:fs";
const [serverPath, pendingPath, reportPath] = process.argv.slice(2);
if (serverPath === undefined || pendingPath === undefined || reportPath === undefined) {
  throw new Error("Missing fixture path");
}
const pending = new Promise<Response>(() => {});
const socketKinds = new Set<string>();
const keepalive = setInterval(() => {}, 1_000);
const server = Bun.serve<{ kind: string }>({
  port: 0,
  fetch(request, current) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/pending") {
      writeFileSync(pendingPath, "pending\\n");
      return pending;
    }
    const kind = pathname === "/realtime" ? "realtime" : pathname === "/runner" ? "runner" : undefined;
    return kind !== undefined && current.upgrade(request, { data: { kind } })
      ? undefined
      : new Response("Not found", { status: 404 });
  },
  websocket: {
    close(socket) {
      socketKinds.delete(socket.data.kind);
    },
    message() {},
    open(socket) {
      socketKinds.add(socket.data.kind);
    },
  },
});
writeFileSync(serverPath, JSON.stringify({ url: String(server.url) }));
process.on("SIGTERM", () => {
  writeFileSync(reportPath, JSON.stringify({
    keepaliveTimers: keepalive === undefined ? 0 : 1,
    openHandles: [
      "keepalive timer",
      ...(server.pendingRequests === 0 ? [] : ["in-flight HTTP request"]),
      ...[...socketKinds].sort().map((kind) => kind + " socket"),
    ],
    pendingRequests: server.pendingRequests,
    pendingWebSockets: server.pendingWebSockets,
    socketKinds: [...socketKinds].sort(),
  }));
  process.send?.("q-mush:final-shutdown-prepared");
  void server.stop();
});
`,
    );
    server = startDevelopmentServer(
      shutdownServerOptions(directory, triggerPath, [
        process.execPath,
        childPath,
        serverPath,
        pendingPath,
        reportPath,
      ]),
    );
    const serverState = await waitForJson(serverPath);
    const url =
      typeof serverState === "object" &&
      serverState !== null &&
      "url" in serverState &&
      typeof serverState.url === "string"
        ? serverState.url
        : "";
    expect(url).toMatch(/^http:\/\//u);
    sockets.push(
      await openSocket(new URL("/realtime", url).toString()),
      await openSocket(new URL("/runner", url).toString()),
    );
    pendingRequest = fetch(new URL("/pending", url)).catch(() => undefined);
    await waitForFile(pendingPath);

    await stoppedWithin(server, 60);
    server = undefined;
    expect(await waitForJson(reportPath)).toEqual({
      keepaliveTimers: 1,
      openHandles: [
        "keepalive timer",
        "in-flight HTTP request",
        "realtime socket",
        "runner socket",
      ],
      pendingRequests: 1,
      pendingWebSockets: 2,
      socketKinds: ["realtime", "runner"],
    });
    await pendingRequest;
    expect(
      sockets.every(({ readyState }) => readyState === WebSocket.CLOSED),
    ).toBe(true);
  } finally {
    if (server !== undefined) {
      await server.forceStop();
    }
    sockets.forEach((socket) => {
      socket.close();
    });
    await Promise.all([pendingRequest, rm(directory, { recursive: true })]);
  }
});

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const INDEX_PATH = join(PROJECT_ROOT, "sync-engine", "index.ts");
const RECOVERY_FIXTURE_PATH = join(
  import.meta.dirname,
  "fixtures",
  "development-shutdown-recovery.ts",
);

async function runRecoveryFixture(
  databasePath: string,
  statePath: string,
): Promise<void> {
  const recoveryArguments = [databasePath, statePath, "recover"];
  const recovery = Bun.spawn(
    [process.execPath, RECOVERY_FIXTURE_PATH, ...recoveryArguments],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, standardError] = await Promise.all([
    recovery.exited,
    new Response(recovery.stderr).text(),
  ]);
  expect(exitCode, standardError).toBe(0);
}

function startRecoveryFixture(
  directory: string,
  triggerPath: string,
  databasePath: string,
  statePath: string,
  mode: "start" | "start-no-ack",
): DevelopmentServer {
  return startDevelopmentServer(
    shutdownServerOptions(directory, triggerPath, [
      process.execPath,
      RECOVERY_FIXTURE_PATH,
      databasePath,
      statePath,
      mode,
    ]),
  );
}

function maintenancePaths(
  directory: string,
  stateName: string,
): { readonly databasePath: string; readonly statePath: string } {
  return {
    databasePath: join(directory, "fixture.sqlite"),
    statePath: join(directory, stateName),
  };
}

async function withMaintenancePaths(
  prefix: string,
  stateName: string,
  run: (
    directory: string,
    triggerPath: string,
    databasePath: string,
    statePath: string,
  ) => Promise<void>,
): Promise<void> {
  await useDevelopmentServer(prefix, async (directory, triggerPath) => {
    const paths = maintenancePaths(directory, stateName);
    await run(directory, triggerPath, paths.databasePath, paths.statePath);
  });
}

async function expectRecoveredSession(
  databasePath: string,
  statePath: string,
): Promise<void> {
  await runRecoveryFixture(databasePath, statePath);
  const recovered: unknown = await Bun.file(statePath).json();
  expect(recovered).toMatchObject({
    restartHandoff: { restartId: "bounded-final-shutdown" },
    status: "paused",
  });
}

async function useRecoveryFixture(
  prefix: string,
  mode: "start" | "start-no-ack",
  stop: (server: DevelopmentServer) => Promise<void>,
): Promise<void> {
  await withMaintenancePaths(
    prefix,
    "state.json",
    async (directory, triggerPath, databasePath, statePath) => {
      const server = startRecoveryFixture(
        directory,
        triggerPath,
        databasePath,
        statePath,
        mode,
      );
      await waitForJson(statePath);
      await stop(server);
      await expectRecoveredSession(databasePath, statePath);
    },
  );
}

test("production shutdown resumes after a bounded database retry", async () => {
  await withMaintenancePaths(
    "q-mush-dev-bounded-retry-test-",
    "bounded-retry.txt",
    async (directory, triggerPath, databasePath, statePath) => {
      const server = startDevelopmentServer(
        shutdownServerOptions(
          directory,
          triggerPath,
          [
            "/bin/sh",
            "-c",
            'cd "$1" && DATABASE_PATH="$2" PORT=0 Q_MUSH_TEST_DATABASE_BOUNDED_RETRY_STATE_PATH="$3" exec "$4" "$5"',
            "q-mush-index-fixture",
            PROJECT_ROOT,
            databasePath,
            statePath,
            process.execPath,
            INDEX_PATH,
          ],
          {
            shutdownForceMilliseconds: 1_000,
            shutdownGraceMilliseconds: 5_000,
            shutdownPreparationMilliseconds: 5_000,
          },
        ),
      );
      await expect
        .poll(
          async () =>
            (await Bun.file(statePath).exists())
              ? (await Bun.file(statePath).text()).includes("write-attempt:2")
              : false,
          { interval: 10, timeout: 60_000 },
        )
        .toBe(true);

      await server.stop();

      expect((await Bun.file(statePath).text()).trim().split("\n")).toEqual([
        "write-attempt:1",
        "write-attempt:2",
        "write-attempt:3",
        "write-attempt:4",
        "caller:typed-disk-full-error",
        "shutdown:prepared",
        "shutdown:acknowledged",
        "shutdown:drained",
        "shutdown:servers-closed",
        "shutdown:database-closed",
      ]);
    },
  );
}, 90_000);

test("recovers a session when forced shutdown waits for the durable marker", async () => {
  await useRecoveryFixture(
    "q-mush-dev-recovery-test-",
    "start",
    async (server) => {
      const stopping = server.stop();
      await Bun.sleep(20);
      await server.forceStop();
      await stopping;
    },
  );
});

test("bounds shutdown when a live child never acknowledges preparation", async () => {
  await useRecoveryFixture(
    "q-mush-dev-no-ack-test-",
    "start-no-ack",
    async (server) => {
      await stoppedWithin(server, 500);
    },
  );
});

test("a repeat shutdown signal escalates after forced shutdown settles", async () => {
  const stopped = Promise.withResolvers<undefined>();
  const forceStopped = Promise.withResolvers<undefined>();
  const events: string[] = [];
  const developmentServer: DevelopmentServer = {
    forceStop: vi.fn(() => {
      events.push("forced");
      return forceStopped.promise;
    }),
    stop: vi.fn(() => {
      events.push("stopping");
      return stopped.promise;
    }),
  };
  const shutDown = createDevelopmentShutdown({
    developmentServer,
    exit: (code) => {
      events.push(`exit ${String(code)}`);
    },
    stopSourceWatcher: () => {
      events.push("watcher stopped");
    },
  });

  shutDown(130);
  expect(events).toEqual(["watcher stopped", "stopping"]);

  shutDown(143);
  expect(events).toEqual(["watcher stopped", "stopping", "forced"]);

  forceStopped.resolve(undefined);
  await forceStopped.promise;
  await Promise.resolve();
  const escalatedEvents = ["watcher stopped", "stopping", "forced", "exit 143"];
  expect(events).toEqual(escalatedEvents);

  stopped.resolve(undefined);
  await stopped.promise;
  await Promise.resolve();
  expect(events).toEqual(escalatedEvents);
});
