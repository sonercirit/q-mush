/* jscpd:ignore-start */
import { describe, expect, test } from "vitest";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";

describe("session runtimes", () => {
  test("does not launch the same session twice while it is active", async () => {
    const runtimes = new SessionRuntimes();
    let release: (() => void) | undefined;
    const firstSettled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launches = 0;

    expect(
      runtimes.launch("session-1", async () => {
        launches += 1;
        await firstSettled;
      }),
    ).toBe(true);
    expect(
      runtimes.launch("session-1", () => {
        launches += 1;
        return Promise.resolve();
      }),
    ).toBe(false);

    await Promise.resolve();
    expect(launches).toBe(1);
    release?.();
    await runtimes.wait("session-1");
    expect(runtimes.active("session-1")).toBe(false);
    expect(
      runtimes.launch("session-1", () => {
        launches += 1;
        return Promise.resolve();
      }),
    ).toBe(true);
  });
});
/* jscpd:ignore-end */
