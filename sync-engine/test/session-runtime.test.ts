import { describe, expect, test } from "vitest";
import type { SessionRuntimePendingComponent } from "../../shared/session-model.ts";
import {
  createSessionRuntimes,
  type SessionRuntimes,
  type RestartRequest,
  type RestartScope,
} from "../../sync-engine/session-runtime.ts";

interface DeferredRuntime {
  readonly finish: () => void;
  readonly launched: boolean;
  readonly request: () => RestartRequest | undefined;
}

function deferredPromise(assign: (finish: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    assign(resolve);
  });
}

function deferredRuntime(
  runtimes: SessionRuntimes,
  sessionId: string,
  runnerId: string,
): DeferredRuntime {
  let finish: (() => void) | undefined;
  let request: (() => RestartRequest | undefined) | undefined;
  const launched = runtimes.launch(sessionId, runnerId, (context) => {
    request = context.restartRequest;
    return deferredPromise((resolve) => {
      finish = resolve;
    });
  });
  return {
    finish: () => {
      finish?.();
    },
    launched,
    request: () => request?.(),
  };
}

function pendingRuntime(runtimes: SessionRuntimes, generation: number) {
  let finish: (() => void) | undefined;
  let pending:
    ((component: SessionRuntimePendingComponent) => void) | undefined;
  const launched = runtimes.launch(
    "session-1",
    "runner-1",
    generation,
    ({ pendingComponent }) => {
      pending = pendingComponent;
      return deferredPromise((resolve) => {
        finish = resolve;
      });
    },
  );
  return {
    finish: () => finish?.(),
    launched,
    pending: (value: SessionRuntimePendingComponent) => pending?.(value),
  };
}

function activeRuntimes(runtimes: SessionRuntimes) {
  return [
    deferredRuntime(runtimes, "session-1", "runner-1"),
    deferredRuntime(runtimes, "session-2", "runner-2"),
  ] as const;
}

function runnerScope(
  runnerId = "runner-1",
): Extract<RestartScope, { readonly kind: "runner" }> {
  return { kind: "runner", runnerId };
}

async function activeRuntimePair(
  runtimes: SessionRuntimes,
): Promise<readonly [DeferredRuntime, DeferredRuntime]> {
  const active = activeRuntimes(runtimes);
  await Promise.resolve();
  return active;
}

async function settleAll(
  drain: Promise<void>,
  ...runtimes: DeferredRuntime[]
): Promise<void> {
  for (const runtime of runtimes) {
    runtime.finish();
  }
  await drain;
}

function expectRunnerAccepts(
  runtimes: SessionRuntimes,
  expected: boolean,
): void {
  expect(runtimes.accepts("runner-1")).toBe(expected);
}

function expectRunnerBlocked(runtimes: SessionRuntimes): void {
  expectRunnerAccepts(runtimes, false);
  expect(deferredRuntime(runtimes, "session-1", "runner-1").launched).toBe(
    false,
  );
}

function expectRunnerOperation(
  operation: "restore" | "resume",
  runtimes: SessionRuntimes,
  restartId: string,
  expected: boolean,
): void {
  const result =
    operation === "resume"
      ? runtimes.resumeRunner("runner-1", restartId)
      : runtimes.restoreRunner("runner-1", restartId);
  expect(result).toBe(expected);
  if (operation === "resume") {
    expectRunnerAccepts(runtimes, expected);
  }
}

function releaseRunner(
  runtimes: SessionRuntimes,
  restartId: string,
  expected: boolean,
): void {
  expectRunnerOperation("resume", runtimes, restartId, expected);
}

function restoreRunnerGate(
  runtimes: SessionRuntimes,
  restartId: string,
  expected: boolean,
): void {
  expectRunnerOperation("restore", runtimes, restartId, expected);
}

describe("session runtimes", () => {
  test("tracks pending components with a shared clock and generation fencing", async () => {
    let now = 101;
    const runtimes = createSessionRuntimes(() => now);
    const runtime = pendingRuntime(runtimes, 4);
    expect(runtime.launched).toBe(true);

    runtime.pending("provider_admission");
    expect(runtimes.pending("session-1", 4)).toEqual({
      component: "provider_admission",
      since: 101,
    });
    expect(runtimes.pending("session-1", 3)).toBeUndefined();

    now = 202;
    runtime.pending("provider_request");
    expect(runtimes.pending("session-1", 4)).toEqual({
      component: "provider_request",
      since: 202,
    });
    runtime.finish();
    await runtimes.settled("session-1");
    expect(runtimes.pending("session-1", 4)).toBeUndefined();
  });

  test("fences stale callbacks and aborts after generation replacement", async () => {
    const runtimes = createSessionRuntimes();
    const stale = pendingRuntime(runtimes, 1);
    expect(stale.launched).toBe(true);
    stale.finish();
    await runtimes.settled("session-1");

    const replacement = Promise.withResolvers<undefined>();
    let replacementSignal: AbortSignal | undefined;
    expect(
      runtimes.launch("session-1", "runner-1", 2, ({ controller }) => {
        replacementSignal = controller.signal;
        return replacement.promise;
      }),
    ).toBe(true);
    stale.pending("provider_request");

    expect(runtimes.pending("session-1", 2)).toMatchObject({
      component: "startup",
    });
    expect(runtimes.abortForGeneration("session-1", 1)).toBe(false);
    expect(replacementSignal).toMatchObject({ aborted: false });
    replacement.resolve();
  });

  test("rejects duplicate launches without replacing the active runtime", async () => {
    const runtimes = createSessionRuntimes();
    const first = deferredRuntime(runtimes, "session-1", "runner-1");
    await Promise.resolve();

    expect(first.launched).toBe(true);
    expect(
      runtimes.launch("session-1", "runner-2", () => Promise.resolve()),
    ).toBe(false);
    expect(runtimes.active("session-1")).toBe(true);

    first.finish();
    await runtimes.settled("session-1");
    expect(runtimes.active("session-1")).toBe(false);
  });

  test("publishes restart identity to every active runtime before awaiting settlement", async () => {
    const runtimes = createSessionRuntimes();
    const persisted: RestartRequest[] = [];
    let finish: (() => void) | undefined;
    expect(
      runtimes.launch("session-1", "runner-1", ({ restartRequest }) => {
        restartRequest((request, durable) => {
          if (!durable) {
            throw new Error("The shutdown marker was not durable");
          }
          persisted.push(request);
        });

        return deferredPromise((resolve) => {
          finish = resolve;
        });
      }),
    ).toBe(true);

    const drain = runtimes.mark(runnerScope(), "durable-before-await");
    await drain;
    expect(persisted).toEqual([
      {
        boundary: "handoff",
        requestedBy: "runner",
        restartId: "durable-before-await",
      },
    ]);
    finish?.();
  });

  test("clears a durable marker after the runtime settles cleanly", async () => {
    const runtimes = createSessionRuntimes();
    let finish: (() => void) | undefined;
    let cleared = false;
    expect(
      runtimes.launch(
        "session-1",
        "runner-1",
        ({ restartRequest, settled }) => {
          restartRequest(() => undefined);
          settled(() => {
            cleared = true;
          });
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      ),
    ).toBe(true);

    await runtimes.mark({ kind: "server" }, "server-shutdown");
    expect(cleared).toBe(false);
    finish?.();
    await runtimes.settled("session-1");
    expect(cleared).toBe(true);
  });

  test("scopes runner drains and retains them until exact acknowledgement", async () => {
    const runtimes = createSessionRuntimes();
    const active = activeRuntimes(runtimes);
    await Promise.resolve();

    const drain = runtimes.drain(runnerScope(), "restart-1");
    expect(active[0].request()).toEqual({
      boundary: "handoff",
      requestedBy: "runner",
      restartId: "restart-1",
    });
    expect(active[1].request()).toBeUndefined();
    expect([
      runtimes.accepts("runner-1"),
      runtimes.accepts("runner-2"),
    ]).toEqual([false, true]);

    for (const [restartId, accepts] of [
      ["wrong-restart", false],
      ["restart-1", true],
    ] as const) {
      releaseRunner(runtimes, restartId, accepts);
    }
    expect(active[0].request()).toBeUndefined();

    await settleAll(drain, ...active);
  });

  test("server drains include every active runner", async () => {
    const runtimes = createSessionRuntimes();
    const active = await activeRuntimePair(runtimes);

    const drain = runtimes.drain({ kind: "server" }, "server-restart");
    const serverRequest: RestartRequest = {
      boundary: "handoff",
      requestedBy: "server",
      restartId: "server-restart",
    };
    for (const runtime of active) {
      expect(runtime.request()).toEqual(serverRequest);
    }
    expectRunnerAccepts(runtimes, false);
    expect(runtimes.accepts("runner-2")).toBe(false);

    await settleAll(drain, ...active);
    expect(runtimes.draining).toBe(true);
    runtimes.start();
    expect(runtimes.draining).toBe(false);
  });

  test("preserves the first request during overlapping drains", async () => {
    const runtimes = createSessionRuntimes();
    const runtime = deferredRuntime(runtimes, "session-1", "runner-1");
    await Promise.resolve();

    const drains = [
      runtimes.drain(runnerScope(), "runner-restart"),
      runtimes.drain({ kind: "server" }, "server-restart"),
    ];
    const storedRequest = runtime.request();
    expect(storedRequest).toMatchObject({
      requestedBy: "runner",
      restartId: "runner-restart",
    });

    runtime.finish();
    await Promise.all(drains);
    expect(runtimes.drainRequest({ kind: "server" })).toEqual({
      boundary: "step",
      requestedBy: "server",
      restartId: "server-restart",
    });
  });

  test("retains a completed runner drain across disconnect until acknowledgement", async () => {
    const runtimes = createSessionRuntimes();
    await runtimes.drain(runnerScope(), "restart-1");
    expectRunnerBlocked(runtimes);
    releaseRunner(runtimes, "restart-1", true);
  });

  test("restoring an exact gate is idempotent and conflicting IDs fail closed", () => {
    const runtimes = createSessionRuntimes();

    restoreRunnerGate(runtimes, "restart-restored", true);
    restoreRunnerGate(runtimes, "restart-restored", true);
    expect(() =>
      runtimes.restoreRunner("runner-1", "restart-conflict"),
    ).toThrow("different restart");
    expect(runtimes.drainRequest(runnerScope())).toEqual({
      boundary: "handoff",
      requestedBy: "runner",
      restartId: "restart-restored",
    });
    expectRunnerBlocked(runtimes);
    releaseRunner(runtimes, "wrong-restart", false);
    releaseRunner(runtimes, "restart-restored", true);
  });

  test("server gates stay authoritative over restored runner gates", async () => {
    const runtimes = createSessionRuntimes();

    restoreRunnerGate(runtimes, "runner-restart", true);
    await runtimes.drain({ kind: "server" }, "server-restart");
    restoreRunnerGate(runtimes, "runner-restart", false);
    runtimes.start();

    expectRunnerAccepts(runtimes, false);
    releaseRunner(runtimes, "runner-restart", true);
  });

  test("rejects conflicting restart IDs for one scope", async () => {
    const runtimes = createSessionRuntimes();
    const initialDrain = runtimes.drain(runnerScope("runner-1"), "first");
    await initialDrain;
    const conflictingDrain = runtimes.drain(runnerScope("runner-1"), "second");

    await expect(conflictingDrain).rejects.toThrow("different restart");
  });
});
