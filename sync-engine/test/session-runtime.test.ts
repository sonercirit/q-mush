import { describe, expect, test } from "vitest";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";

function deferredRuntime(runtimes: SessionRuntimes, runnerId: string) {
  let finish: (() => void) | undefined;
  let request: (() => unknown) | undefined;
  expect(
    runtimes.launch("session-1", runnerId, (context) => {
      request = context.restartRequest;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    }),
  ).toBe(true);
  return {
    finish: () => {
      finish?.();
    },
    request: () => request?.(),
  };
}

describe("session runtimes", () => {
  test("rejects conflicting restart IDs for the same scope", async () => {
    const runtimes = new SessionRuntimes();

    await runtimes.drain({ kind: "runner", runnerId: "runner-1" }, "first");
    await expect(
      runtimes.drain({ kind: "runner", runnerId: "runner-1" }, "second"),
    ).rejects.toThrow("different restart");
  });

  test("preserves the first runtime handoff during overlapping drains", async () => {
    const runtimes = new SessionRuntimes();
    const runtime = deferredRuntime(runtimes, "runner-1");
    await Promise.resolve();

    const runnerDrain = runtimes.drain(
      { kind: "runner", runnerId: "runner-1" },
      "runner-restart",
    );
    const serverDrain = runtimes.drain({ kind: "server" }, "server-restart");
    expect(runtime.request()).toEqual({
      requestedBy: "runner",
      restartId: "runner-restart",
    });

    runtime.finish();
    await expect(Promise.all([runnerDrain, serverDrain])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(runtimes.drainRequest({ kind: "server" })).toEqual({
      requestedBy: "server",
      restartId: "server-restart",
    });
  });
});
