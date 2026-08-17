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
  requestedDrains = 0;
  readonly drains: {
    readonly restartId: string;
    readonly scope: RestartScope;
  }[] = [];
  readonly started: (string | undefined)[] = [];
  #runnerRequests = new Map<string, RestartRequest>();
  #serverRequest: RestartRequest | undefined;

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
    return this.drain(scope, restartId);
  }

  drainProgress(): readonly [] {
    return [];
  }

  forcePark(): Promise<readonly string[]> {
    return Promise.resolve(this.forceParked);
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
    return { persistence, settled: persistence };
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

function control(generateRestartId: () => string = () => "unused") {
  const runtimes = new TestRestartRuntimes();
  return {
    restart: createSessionRestartControl(runtimes, generateRestartId),
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

  test("keeps final shutdown drain unbounded after its durable marker", async () => {
    const { restart, runtimes } = control(() => "final-shutdown");

    await restart.prepareServerShutdown();
    await restart.drainServerFinal();

    expect(runtimes.requestedDrains).toBe(0);
    expect(runtimes.drains).toEqual([
      { restartId: "final-shutdown", scope: { kind: "server" } },
      { restartId: "final-shutdown", scope: { kind: "server" } },
    ]);
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
    const { restart, runtimes } = control(() => "server-1");

    await restart.drainServer();
    await restart.drainRunner("runner-1", "runner-1");

    expect(runtimes.drains).toEqual([
      { restartId: "server-1", scope: { kind: "server" } },
      { restartId: "server-1", scope: { kind: "server" } },
    ]);
  });

  test("escalates a pending runner drain through its dedicated boundary", async () => {
    const { restart } = control();
    const pending = restart.drainRunner("runner-1", "runner-restart");

    expect(restart.escalateRunnerDrain("runner-1", "runner-restart")).toBe(
      true,
    );
    await pending;
    expect(restart.escalateRunnerDrain("runner-1", "stale-restart")).toBe(
      false,
    );
  });

  test("releases only the exact acknowledged runner restart", async () => {
    const { restart } = control();
    await restart.drainRunner("runner-1", "runner-restart");

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
    await restart.drainRunner("runner-1", "runner-restart");

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
