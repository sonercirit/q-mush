import { describe, expect, test } from "vitest";
import { executeWithAbortSignal } from "../validation.ts";

describe("executeWithAbortSignal", () => {
  test("rejects promptly when abort cleanup never settles", async () => {
    const controller = new AbortController();
    const operation = Promise.withResolvers<string>();
    const result = executeWithAbortSignal(
      controller.signal,
      {
        abortMessage: "The operation was stopped",
        onAbort: () => new Promise(() => undefined),
      },
      () => operation.promise,
    );
    const reason = new DOMException("stopped promptly", "AbortError");

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    operation.reject(new Error("late failure"));
    await Promise.resolve();
  });
});
