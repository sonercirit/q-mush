import { expect, test } from "vitest";
import { SessionRuntimes } from "../session-runtime.ts";

test("tool changes abort only the runtime with the fenced generation", async () => {
  const runtimes = new SessionRuntimes();
  let oldAborted = false;
  let settleOld = (): void => undefined;
  expect(
    runtimes.launch("session-1", "runner-1", 3, ({ controller }) => {
      controller.signal.addEventListener("abort", () => {
        oldAborted = true;
        settleOld();
      });
      return new Promise<void>((resolve) => {
        settleOld = resolve;
      });
    }),
  ).toBe(true);

  expect(runtimes.abortForGeneration("session-1", 2)).toBe(false);
  expect(oldAborted).toBe(false);
  expect(runtimes.abortForGeneration("session-1", 3)).toBe(true);
  await runtimes.settled("session-1");
  expect(oldAborted).toBe(true);
});
