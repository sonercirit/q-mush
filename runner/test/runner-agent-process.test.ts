import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import {
  runnerRegistrationRejectedMessage,
  runnerSupersededMessage,
} from "../../shared/runner-realtime-protocol.ts";

const RUNNER_VERSION = "a".repeat(64);
const POLL_INTERVAL_MILLISECONDS = 10;
const RUNNER_STARTUP_TIMEOUT_MILLISECONDS = 10_000;

function waitForExit(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  milliseconds: number,
): Promise<number | "timeout"> {
  return Promise.race([
    child.exited,
    Bun.sleep(milliseconds).then(() => "timeout" as const),
  ]);
}

async function waitUntil(
  condition: () => boolean,
  milliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MILLISECONDS);
  }
  return condition();
}

interface RunnerTestSocketData {
  heartbeat: boolean;
  nextMessage: number;
  operational: boolean;
}

interface RunnerTestServerOptions {
  readonly command?: RunnerToolCommand;
  readonly rejectRegistration?: boolean;
  readonly transientRegistrationFailures?: number;
}

interface RunnerConnectRecord {
  readonly processNonce: string | undefined;
}

function operationalSocket(
  sockets: ReadonlySet<Bun.ServerWebSocket<RunnerTestSocketData>>,
  required: keyof Pick<RunnerTestSocketData, "heartbeat" | "operational">,
): Bun.ServerWebSocket<RunnerTestSocketData> | undefined {
  return [...sockets].find(({ data }) => data[required]);
}

function runnerServer(options: RunnerTestServerOptions = {}): Readonly<{
  readonly origin: string;
  acknowledge(commandId: string): boolean;
  attempts(): number;
  connections(): readonly RunnerConnectRecord[];
  disconnect(): boolean;
  registered(): boolean;
  results(): readonly Readonly<Record<string, unknown>>[];
  stop(): void;
  supersede(): boolean;
}> {
  const registrationId = "process-registration";
  const receipt = "process-receipt";
  const messages = [
    {
      registrationId,
      runnerId: "runner-process",
      type: "registration_ready",
      version: RUNNER_VERSION,
    },
    { registrationId, type: "registration_committed" },
    {
      activationReceipt: receipt,
      registrationId,
      type: "registration_active",
    },
    {
      activationReceipt: receipt,
      registrationId,
      type: "registration_finalized",
    },
    { registrationId, type: "registration_operational" },
  ];
  let attempts = 0;
  const connections: RunnerConnectRecord[] = [];
  const results: Readonly<Record<string, unknown>>[] = [];
  const sockets = new Set<Bun.ServerWebSocket<RunnerTestSocketData>>();
  const sendNext = (
    socket: Bun.ServerWebSocket<RunnerTestSocketData>,
  ): void => {
    const message = messages[socket.data.nextMessage++];
    if (message === undefined) {
      socket.data.operational = true;
      if (options.command !== undefined) {
        socket.send(
          JSON.stringify({ command: options.command, type: "command" }),
        );
      }
    } else {
      socket.send(JSON.stringify(message));
    }
  };
  const server = Bun.serve<RunnerTestSocketData>({
    fetch: (request, bunServer) => {
      if (new URL(request.url).pathname === "/api/runner/realtime") {
        return bunServer.upgrade(request, {
          data: { heartbeat: false, nextMessage: 0, operational: false },
        })
          ? undefined
          : new Response("Upgrade failed", { status: 400 });
      }
      return new Response(null, { status: 304 });
    },
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      close: (socket) => {
        sockets.delete(socket);
      },
      message: (socket, message) => {
        const value: unknown = JSON.parse(String(message));
        if (
          typeof value !== "object" ||
          value === null ||
          !("type" in value) ||
          typeof value.type !== "string"
        ) {
          return;
        }
        if (value.type === "heartbeat") {
          socket.data.heartbeat = true;
          return;
        }
        if (value.type === "result") {
          results.push(value);
          return;
        }
        if (value.type === "connect") {
          connections.push({
            processNonce:
              "processNonce" in value && typeof value.processNonce === "string"
                ? value.processNonce
                : undefined,
          });
        }
        if (
          value.type === "connect" &&
          attempts <= (options.transientRegistrationFailures ?? 0)
        ) {
          socket.close(1011, "Transient setup failure");
          return;
        }
        if (value.type === "connect" && options.rejectRegistration === true) {
          socket.send(runnerRegistrationRejectedMessage());
          setTimeout(() => {
            socket.close(1008, "Registration rejected");
          }, 20);
          return;
        }
        sendNext(socket);
      },
      open: (socket) => {
        attempts += 1;
        sockets.add(socket);
      },
    },
  });
  const controlOperationalSocket = (
    action: (socket: Bun.ServerWebSocket<RunnerTestSocketData>) => void,
  ): boolean => {
    const socket = operationalSocket(sockets, "operational");
    if (socket === undefined) {
      return false;
    }
    action(socket);
    return true;
  };
  const hostname = server.hostname ?? "127.0.0.1";
  return {
    attempts: () => attempts,
    connections: () => connections,
    acknowledge: (commandId: string) =>
      controlOperationalSocket((socket) => {
        socket.send(JSON.stringify({ commandId, type: "result_received" }));
      }),
    disconnect: () =>
      controlOperationalSocket((socket) => {
        socket.close(1012, "Fixture connection blip");
      }),
    origin: `http://${hostname}:${String(server.port)}`,
    registered: () => [...sockets].some(({ data }) => data.operational),
    results: () => results,
    stop: () => {
      void server.stop(true);
    },
    supersede: () => {
      const socket = operationalSocket(sockets, "heartbeat");
      if (socket === undefined) {
        return false;
      }
      socket.send(runnerSupersededMessage());
      return true;
    },
  };
}

function spawnRunner(
  configurationPath: string,
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn(
    [
      process.execPath,
      "--define",
      'Q_MUSH_RUNNER_TARGET="bun-linux-x64"',
      "--define",
      `Q_MUSH_RUNNER_VERSION="${RUNNER_VERSION}"`,
      "runner/runner-agent.ts",
      "--config",
      configurationPath,
      "--restart-id",
      "process-restart",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
}

function processTestSetup(options?: RunnerTestServerOptions): Readonly<{
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly directory: string;
  readonly server: ReturnType<typeof runnerServer>;
}> {
  const directory = mkdtempSync(join(tmpdir(), "q-mush-runner-exit-test-"));
  const configurationPath = join(directory, "runner.conf");
  const server = runnerServer(options);
  writeFileSync(
    configurationPath,
    `${server.origin}\nqmr_process_test_token\n`,
  );
  return { child: spawnRunner(configurationPath), directory, server };
}

async function cleanupProcessTest(
  setup: ReturnType<typeof processTestSetup>,
): Promise<void> {
  if (setup.child.exitCode === null) {
    setup.child.kill();
    await setup.child.exited;
  }
  setup.server.stop();
  rmSync(setup.directory, { force: true, recursive: true });
}

function childStderr(
  setup: ReturnType<typeof processTestSetup>,
): Promise<string> {
  return new Response(setup.child.stderr).text();
}

async function expectChildFailure(
  setup: ReturnType<typeof processTestSetup>,
  message: string,
): Promise<void> {
  expect(await waitForExit(setup.child, 900)).toBe(1);
  expect(await childStderr(setup)).toContain(message);
}

test("a command executes once and reports through the reconnected socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "q-mush-runner-blip-test-"));
  const auditPath = join(directory, "audit.log");
  const command: RunnerToolCommand = {
    arguments: {
      command: `printf x >> ${JSON.stringify(auditPath)}; sleep 1`,
      timeout: 10,
    },
    executionEnvironment: "bare_metal",
    id: "blip-command",
    sessionId: "blip-session",
    tool: "bash",
    workingDirectory: directory,
  };
  const setup = processTestSetup({ command });

  try {
    expect(
      await waitUntil(() => {
        try {
          return readFileSync(auditPath, "utf8") === "x";
        } catch {
          return false;
        }
      }, 2_000),
    ).toBe(true);
    expect(setup.server.disconnect()).toBe(true);
    expect(await waitUntil(() => setup.server.attempts() === 2, 7_000)).toBe(
      true,
    );
    expect(setup.server.connections()).toHaveLength(2);
    expect(setup.server.connections()[0]?.processNonce).toBeDefined();
    expect(setup.server.connections()[1]?.processNonce).toBe(
      setup.server.connections()[0]?.processNonce,
    );
    expect(
      await waitUntil(() => setup.server.results().length === 1, 2_000),
    ).toBe(true);
    expect(setup.server.results()[0]).toMatchObject({
      commandId: command.id,
      state: "completed",
      type: "result",
    });
    expect(readFileSync(auditPath, "utf8")).toBe("x");
    expect(setup.server.acknowledge(command.id)).toBe(true);
  } finally {
    await cleanupProcessTest(setup);
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true });
    }
  }
});

test("the runner process exits promptly when superseded mid-heartbeat", async () => {
  const setup = processTestSetup();

  try {
    expect(
      await waitUntil(
        () => setup.server.supersede(),
        RUNNER_STARTUP_TIMEOUT_MILLISECONDS,
      ),
    ).toBe(true);
    await expectChildFailure(
      setup,
      "The runner connection was superseded by a newer process",
    );
  } finally {
    await cleanupProcessTest(setup);
  }
});

test("a restart runner retries a transient registration failure", async () => {
  const setup = processTestSetup({ transientRegistrationFailures: 1 });

  try {
    expect(await waitUntil(() => setup.server.registered(), 7_000)).toBe(true);
    expect(setup.server.attempts()).toBe(2);
    expect(setup.child.exitCode).toBeNull();
  } finally {
    await cleanupProcessTest(setup);
  }
});

test("a stale restart runner exits after one explicit registration rejection", async () => {
  const setup = processTestSetup({ rejectRegistration: true });

  try {
    await expectChildFailure(
      setup,
      "The runner registration was rejected by Q Mush",
    );
    await Bun.sleep(100);
    expect(setup.server.attempts()).toBe(1);
  } finally {
    await cleanupProcessTest(setup);
  }
});
