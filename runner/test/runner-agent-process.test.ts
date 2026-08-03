import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runnerSupersededMessage } from "../../shared/runner-realtime-protocol.ts";

const RUNNER_VERSION = "a".repeat(64);

function waitForExit(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  milliseconds: number,
): Promise<number | "timeout"> {
  return Promise.race([
    child.exited,
    Bun.sleep(milliseconds).then(() => "timeout" as const),
  ]);
}

interface RunnerTestSocketData {
  heartbeat: boolean;
  nextMessage: number;
  operational: boolean;
}

function runnerServer(): Readonly<{
  readonly origin: string;
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
  const sockets = new Set<Bun.ServerWebSocket<RunnerTestSocketData>>();
  const sendNext = (
    socket: Bun.ServerWebSocket<RunnerTestSocketData>,
  ): void => {
    const message = messages[socket.data.nextMessage++];
    if (message === undefined) {
      socket.data.operational = true;
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
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "heartbeat"
        ) {
          socket.data.heartbeat = true;
        }
        sendNext(socket);
      },
      open: (socket) => {
        sockets.add(socket);
        sendNext(socket);
      },
    },
  });
  const hostname = server.hostname ?? "127.0.0.1";
  return {
    origin: `http://${hostname}:${String(server.port)}`,
    stop: () => {
      void server.stop(true);
    },
    supersede: () => {
      const socket = [...sockets].find(({ data }) => data.heartbeat);
      if (socket === undefined) {
        return false;
      }
      socket.send(runnerSupersededMessage());
      return true;
    },
  };
}

test("the runner process exits promptly when superseded mid-heartbeat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "q-mush-runner-exit-test-"));
  const configurationPath = join(directory, "runner.conf");
  const server = runnerServer();
  writeFileSync(
    configurationPath,
    `${server.origin}\nqmr_process_test_token\n`,
  );
  const child = Bun.spawn(
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

  try {
    let superseded = false;
    for (let index = 0; !superseded && index < 100; index += 1) {
      superseded = server.supersede();
      if (!superseded) await Bun.sleep(10);
    }
    expect(superseded).toBe(true);
    expect(await waitForExit(child, 900)).toBe(1);
    expect(await new Response(child.stderr).text()).toContain(
      "The runner connection was superseded by a newer process",
    );
  } finally {
    if (child.exitCode === null) child.kill();
    server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
