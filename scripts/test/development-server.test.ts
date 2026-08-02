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
) {
  return {
    command,
    cwd: directory,
    restartTriggerPath: triggerPath,
    shutdownForceMilliseconds: 200,
    shutdownGraceMilliseconds: 80,
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
    await waitForFile(serverPath);
    const serverState: unknown = await Bun.file(serverPath).json();
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
    expect(await Bun.file(reportPath).json()).toEqual({
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
      server.forceStop();
    }
    sockets.forEach((socket) => {
      socket.close();
    });
    await Promise.all([pendingRequest, rm(directory, { recursive: true })]);
  }
});

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

test("recovers a session when bounded shutdown kills an in-flight step", async () => {
  await useDevelopmentServer(
    "q-mush-dev-recovery-test-",
    async (directory, triggerPath) => {
      const databasePath = join(directory, "fixture.sqlite");
      const statePath = join(directory, "state.json");
      const recoveryArguments = [databasePath, statePath, "start"];
      const server = startDevelopmentServer(
        shutdownServerOptions(directory, triggerPath, [
          process.execPath,
          RECOVERY_FIXTURE_PATH,
          ...recoveryArguments,
        ]),
      );

      await waitForFile(statePath);
      await stoppedWithin(server, 60);
      await runRecoveryFixture(databasePath, statePath);
      const recovered: unknown = await Bun.file(statePath).json();
      expect(recovered).toMatchObject({
        restartHandoff: { restartId: "bounded-final-shutdown" },
        status: "paused",
      });
    },
  );
});

test("a repeat shutdown signal escalates to immediate forced exit", async () => {
  const stopped = Promise.withResolvers<undefined>();
  const events: string[] = [];
  const developmentServer: DevelopmentServer = {
    forceStop: vi.fn(() => {
      events.push("forced");
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

  const escalatedEvents = ["watcher stopped", "stopping", "forced", "exit 143"];
  shutDown(143);
  expect(events).toEqual(escalatedEvents);

  stopped.resolve(undefined);
  await stopped.promise;
  await Promise.resolve();
  expect(events).toEqual(escalatedEvents);
});
