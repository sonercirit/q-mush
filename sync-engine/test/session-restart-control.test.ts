import { describe, expect, test, vi } from "vitest";
import {
  createSessionRestartControl,
  readSessionRestartCredential,
  type RestartRuntimeControl,
} from "../../sync-engine/session-restart-control.ts";
import type {
  RestartRequest,
  RestartScope,
} from "../../sync-engine/session-runtime.ts";
import { restartTestCredential } from "./session-restart-cpd-helpers.ts";

const OPENROUTER_CREDENTIAL = restartTestCredential("openrouter-credential", {
  accountId: "openrouter-account",
  isDefault: true,
  label: "OpenRouter key",
  secret: "openrouter-secret",
});

function runnerGate(
  gates: Map<string, RestartRequest>,
  runnerId: string,
): RestartRequest | undefined {
  return gates.get(runnerId);
}

class TestRestartRuntimes implements RestartRuntimeControl {
  readonly blocked = new Set<string>();
  readonly forceParked: string[] = [];
  readonly forceParkScopes: RestartScope[] = [];
  forceParkCalls = 0;
  forceParkFailure: Error | undefined;
  markGate: Promise<void> | undefined;
  settleDrainsImmediately = true;
  requestedDrains = 0;
  readonly drains: {
    readonly restartId: string;
    readonly scope: RestartScope;
  }[] = [];
  readonly started: (string | undefined)[] = [];
  #runnerRequests = new Map<string, RestartRequest>();
  #serverRequest: RestartRequest | undefined;
  #settleDrains = new Map<string, () => void>();

  get draining(): boolean {
    return this.#serverRequest !== undefined;
  }

  accepts(runnerId: string): boolean {
    return (
      !this.draining &&
      !this.blocked.has(runnerId) &&
      !this.#runnerRequests.has(runnerId)
    );
  }

  blockRunner(runnerId: string): void {
    this.blocked.add(runnerId);
    this.#runnerRequests.delete(runnerId);
  }

  drain(scope: RestartScope, restartId: string): Promise<void> {
    this.drains.push({ restartId, scope });
    const request: RestartRequest = {
      boundary: scope.kind === "server" ? "step" : "handoff",
      requestedBy: scope.kind,
      restartId,
    };
    if (scope.kind === "server") {
      this.#serverRequest = request;
    } else {
      this.#runnerRequests.set(scope.runnerId, request);
    }
    return Promise.resolve();
  }

  mark(scope: RestartScope, restartId: string): Promise<void> {
    const persistence = this.drain(scope, restartId);
    return this.markGate === undefined
      ? persistence
      : persistence.then(() => this.markGate);
  }

  drainProgress(): readonly [] {
    return [];
  }

  forcePark(scope: RestartScope): Promise<readonly string[]> {
    this.forceParkCalls += 1;
    this.forceParkScopes.push(scope);
    return this.forceParkFailure === undefined
      ? Promise.resolve(this.forceParked)
      : Promise.reject(this.forceParkFailure);
  }

  requestDrain(
    scope: RestartScope,
    restartId: string,
  ): {
    readonly persistence: Promise<unknown>;
    readonly settled: Promise<unknown>;
  } {
    this.requestedDrains += 1;
    const persistence = this.drain(scope, restartId);
    if (this.settleDrainsImmediately) {
      return { persistence, settled: persistence };
    }
    const settled = new Promise<void>((resolve) => {
      const key =
        scope.kind === "server" ? "server" : `runner:${scope.runnerId}`;
      this.#settleDrains.set(key, resolve);
    });
    return { persistence, settled };
  }

  settleDrain(key?: string): void {
    if (key !== undefined) {
      this.#settleDrains.get(key)?.();
      this.#settleDrains.delete(key);
      return;
    }
    for (const settle of this.#settleDrains.values()) settle();
    this.#settleDrains.clear();
  }

  drainRequest(scope: RestartScope): RestartRequest | undefined {
    return scope.kind === "server"
      ? this.#serverRequest
      : runnerGate(this.#runnerRequests, scope.runnerId);
  }

  resumeRunner(runnerId: string, restartId: string): boolean {
    if (runnerGate(this.#runnerRequests, runnerId)?.restartId !== restartId) {
      return false;
    }
    this.#runnerRequests.delete(runnerId);
    return true;
  }

  restoreRunner(runnerId: string, restartId: string): boolean {
    const existing = runnerGate(this.#runnerRequests, runnerId);
    if (existing !== undefined && existing.restartId !== restartId) {
      throw new Error("A different restart is already draining this scope");
    }
    this.#runnerRequests.set(
      runnerId,
      existing ?? {
        boundary: "handoff",
        requestedBy: "runner",
        restartId,
      },
    );
    return true;
  }

  start(runnerId?: string): void {
    this.started.push(runnerId);
    if (runnerId === undefined) {
      this.#serverRequest = undefined;
    }
  }
}

function control(
  generateRestartId: () => string = () => "unused",
  options: Parameters<typeof createSessionRestartControl>[2] = {},
) {
  const runtimes = new TestRestartRuntimes();
  return {
    restart: createSessionRestartControl(runtimes, generateRestartId, options),
    runtimes,
  };
}

function expectRecovery(
  restart: ReturnType<typeof createSessionRestartControl>,
  runnerId?: string,
): (string | undefined)[] {
  const recovered: (string | undefined)[] = [];
  restart.recover((recoveredRunnerId) => {
    recovered.push(recoveredRunnerId);
  }, runnerId);
  return recovered;
}

function recoverRunner(
  restart: ReturnType<typeof createSessionRestartControl>,
  restartId: string,
): (string | undefined)[] {
  expect(restart.resumeRunner("runner-1", restartId)).toBe(true);
  return expectRecovery(restart, "runner-1");
}

function expectRunnerAdmission(
  restart: ReturnType<typeof createSessionRestartControl>,
  expected: boolean,
): void {
  expect(restart.accepts("runner-1")).toBe(expected);
}

function expectRejectedRecovery(
  restart: ReturnType<typeof createSessionRestartControl>,
  restartId: string,
): void {
  expect(restart.resumeRunner("runner-1", restartId)).toBe(false);
  expectRunnerAdmission(restart, false);
}

function finalShutdownControl() {
  return control(() => "final-shutdown");
}

const FINAL_SHUTDOWN_DRAINS = [
  { restartId: "final-shutdown", scope: { kind: "server" } },
  { restartId: "final-shutdown", scope: { kind: "server" } },
] as const;

function expectNoForcePark(runtimes: TestRestartRuntimes): void {
  expect(runtimes.forceParkCalls).toBe(0);
}

function pendingSharedDrain() {
  const setup = control(() => "server");
  setup.runtimes.settleDrainsImmediately = false;
  const server = setup.restart.drainServer();
  const runner = setup.restart.drainRunner("runner-1", "runner-restart");
  return { ...setup, runner, server };
}

async function finishSharedDrain(
  runtimes: TestRestartRuntimes,
  pending: readonly Promise<void>[],
): Promise<void> {
  runtimes.settleDrain();
  await Promise.all(pending);
}

function drainRunner(
  restart: ReturnType<typeof createSessionRestartControl>,
  restartId = "runner-restart",
): Promise<void> {
  return restart.drainRunner("runner-1", restartId);
}

function escalateRunner(
  restart: ReturnType<typeof createSessionRestartControl>,
  restartId: string,
): boolean {
  return restart.escalateRunnerDrain("runner-1", restartId);
}

describe("session restart control", () => {
  test("reuses one server restart ID across repeated drains", async () => {
    let generated = 0;
    const { restart, runtimes } = control(() => {
      generated += 1;
      return `server-${String(generated)}`;
    });

    await restart.drainServer();
    await restart.drainServer();

    expect(generated).toBe(1);
    expect(runtimes.drains.map(({ restartId }) => restartId)).toEqual([
      "server-1",
      "server-1",
    ]);
  });

  test.each([
    ["keeps final shutdown drain unbounded after its durable marker", false],
    ["does not request another bounded drain during final shutdown", true],
  ] as const)("%s", async (_name, includeRunner) => {
    const { restart, runtimes } = finalShutdownControl();
    await restart.prepareServerShutdown();
    await restart.drainServerFinal();
    if (includeRunner) {
      await drainRunner(restart);
      expectNoForcePark(runtimes);
    }
    expect(runtimes.requestedDrains).toBe(0);
    expect(runtimes.drains).toEqual(FINAL_SHUTDOWN_DRAINS);
  });

  test("a runner waits for the final marker without force-parking", async () => {
    const { restart, runtimes } = finalShutdownControl();
    const marker = Promise.withResolvers<undefined>();
    runtimes.markGate = marker.promise;
    const preparing = restart.prepareServerShutdown();
    let runnerSettled = false;
    const runner = restart
      .drainRunner("runner-1", "final-runner")
      .finally(() => {
        runnerSettled = true;
      });
    await Promise.resolve();
    expect(runnerSettled).toBe(false);
    expectNoForcePark(runtimes);
    marker.resolve();
    await Promise.all([preparing, runner]);
    expect(runnerSettled).toBe(true);
    expectNoForcePark(runtimes);
  });

  test("rejects invalid server and runner restart IDs", async () => {
    const { restart: invalidServer } = control(() => "x".repeat(201));
    const { restart: validServer } = control(() => "server");

    await expect(invalidServer.drainServer()).rejects.toThrow("ID is invalid");
    await expect(validServer.drainRunner("runner-1", "   ")).rejects.toThrow(
      "ID is invalid",
    );
  });

  test("uses the exact server handoff when runner drain overlaps it", async () => {
    const setup = control(() => "server-1");
    const { restart, runtimes } = setup;
    await restart.drainServer();
    await restart.drainRunner("runner-overlap", "runner-1");

    expect(runtimes.drains).toEqual([
      { restartId: "server-1", scope: { kind: "server" } },
      { restartId: "server-1", scope: { kind: "server" } },
    ]);
  });

  test("runner drain joins a pending server drain without escalating it", async () => {
    const { restart, runtimes } = control(() => "server-1");
    runtimes.settleDrainsImmediately = false;
    let serverSettled = false;
    let runnerSettled = false;

    const serverDrain = restart.drainServer().then(() => {
      serverSettled = true;
    });
    const runnerDrain = restart.drainRunner("runner-1", "runner-1").then(() => {
      runnerSettled = true;
    });
    await Promise.resolve();

    expectNoForcePark(runtimes);
    expect(serverSettled).toBe(false);
    expect(runnerSettled).toBe(false);

    runtimes.settleDrain();
    await Promise.all([serverDrain, runnerDrain]);
    expectNoForcePark(runtimes);
  });

  test("a runner drain recovers when the active server deadline is unavailable", async () => {
    const warnings = new Array<string>();
    const setup = control(() => "server", {
      warn: warnings.push.bind(warnings),
    });
    const { restart, runtimes } = setup;
    await runtimes.drain({ kind: "server" }, "external-server");
    runtimes.settleDrainsImmediately = false;

    const drain = restart.drainRunner("runner-1", "runner-restart");
    const server = restart.drainServer();
    runtimes.settleDrain("server");
    await server;
    expect(restart.escalateRunnerDrain("runner-1", "runner-restart")).toBe(
      true,
    );
    expect(runtimes.forceParkScopes).toEqual([
      { kind: "runner", runnerId: "runner-1" },
    ]);
    runtimes.settleDrain("runner:runner-1");
    await drain;
    expect(restart.escalateRunnerDrain("runner-1", "runner-restart")).toBe(
      false,
    );

    expect(runtimes.drains).toEqual([
      {
        restartId: "external-server",
        scope: { kind: "server" },
      },
      {
        restartId: "runner-restart",
        scope: { kind: "runner", runnerId: "runner-1" },
      },
      {
        restartId: "external-server",
        scope: { kind: "server" },
      },
    ]);
    expect(warnings).toEqual([
      "The active server restart deadline was unavailable; starting a dedicated runner drain",
    ]);
  });

  test("a late runner keeps the original server deadline", async () => {
    let now = 100;
    const delays = new Array<number>();
    const { restart, runtimes } = control(() => "server", {
      clearTimeout: () => undefined,
      now: () => now,
      setTimeout: (_callback, delay) => {
        delays.push(delay);
        return delays.length;
      },
    });
    runtimes.settleDrainsImmediately = false;
    const server = restart.drainServer();
    runtimes.settleDrain();
    await server;
    now += 60_000;
    const runner = drainRunner(restart);
    expect(delays).toEqual([120_000, 60_000]);
    runtimes.settleDrain();
    await runner;
  });

  test("force-park failure still settles the bounded drain", async () => {
    const warnings = new Array<string>();
    const { restart, runtimes } = control(() => "server", {
      warn: (message) => warnings.push(message),
    });
    runtimes.settleDrainsImmediately = false;
    runtimes.forceParkFailure = new Error("persistence failed");
    const pending = restart.drainServer();
    expect(restart.escalateServerDrain()).toBe(true);
    await pending;
    expect(warnings).toEqual([
      "Q Mush restart force-park failed: Error: persistence failed",
    ]);
  });

  test("a runner-scope drain settling does not drop shared server associations", async () => {
    const { restart, runtimes } = control(() => "server");
    runtimes.settleDrainsImmediately = false;
    const dedicated = restart.drainRunner("runner-dedicated", "dedicated");
    const server = restart.drainServer();
    const shared = restart.drainRunner("runner-shared", "shared");

    runtimes.settleDrain("runner:runner-dedicated");
    await dedicated;

    expect(restart.escalateRunnerDrain("runner-shared", "shared")).toBe(true);
    await Promise.all([server, shared]);
    expect(runtimes.forceParkCalls).toBe(1);
  });

  test.each([
    [
      "a late runner escalates the shared server drain with its restart ID",
      "runner-restart",
      true,
    ],
    ["server drain rejects a stale late-runner escalation", "stale", false],
  ] as const)("%s", async (_name, restartId, expected) => {
    const { restart, runtimes, runner, server } = pendingSharedDrain();
    expect(escalateRunner(restart, restartId)).toBe(expected);
    if (expected) {
      await Promise.all([server, runner]);
      expect(runtimes.forceParkCalls).toBe(1);
    } else {
      expectNoForcePark(runtimes);
      await finishSharedDrain(runtimes, [server, runner]);
    }
  });

  test("escalates a pending runner drain through its dedicated boundary", async () => {
    const { restart } = control();
    const pending = drainRunner(restart);

    expect(escalateRunner(restart, "runner-restart")).toBe(true);
    await pending;
    expect(escalateRunner(restart, "stale-restart")).toBe(false);
  });

  test("releases only the exact acknowledged runner restart", async () => {
    const { restart } = control();
    await drainRunner(restart);

    for (const [restartId, accepts] of [
      ["stale-restart", false],
      ["runner-restart", true],
    ] as const) {
      expect(restart.resumeRunner("runner-1", restartId)).toBe(accepts);
      expectRunnerAdmission(restart, accepts);
    }
  });

  test("recovers a persisted runner gate only with the exact restart ID", async () => {
    const { restart, runtimes } = control();
    await drainRunner(restart);

    expect(expectRecovery(restart)).toEqual([undefined]);
    expect(restart.resumeRunner("runner-1", "stale-restart")).toBe(false);
    expectRunnerAdmission(restart, false);
    expect(runtimes.started).toEqual([undefined]);

    expect(recoverRunner(restart, "runner-restart")).toEqual(["runner-1"]);
    expectRunnerAdmission(restart, true);
    expect(runtimes.started).toEqual([undefined, "runner-1"]);
  });

  test("restoring the same durable runner gate is idempotent", () => {
    const { restart } = control();

    expect(restart.restoreRunner("runner-1", "persisted-restart")).toBe(true);
    expect(restart.restoreRunner("runner-1", "persisted-restart")).toBe(true);
    expectRunnerAdmission(restart, false);
    expectRejectedRecovery(restart, "stale-restart");

    expect(recoverRunner(restart, "persisted-restart")).toEqual(["runner-1"]);
    expectRunnerAdmission(restart, true);
  });

  test("treats credential refresh failures as temporarily unavailable", async () => {
    const readOpenai = vi.fn(() => Promise.reject(new Error("refresh failed")));
    const readOpenrouter = vi.fn(() => OPENROUTER_CREDENTIAL);
    const readers = {
      openai: { readCredential: readOpenai },
      openrouter: { readCredential: readOpenrouter },
    };

    const read = (provider: "openai" | "openrouter") =>
      readSessionRestartCredential(readers, "user", {
        credentialId: `${provider}-credential`,
        provider,
        workspaceId: "workspace-1",
      });
    await expect(read("openai")).resolves.toBeUndefined();
    await expect(read("openrouter")).resolves.toBe(OPENROUTER_CREDENTIAL);
    expect(readOpenai).toHaveBeenCalledWith(
      "user",
      "openai-credential",
      "workspace-1",
    );
    expect(readOpenrouter).toHaveBeenCalledWith(
      "user",
      "openrouter-credential",
      "workspace-1",
    );
  });
});
