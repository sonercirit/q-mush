import { describe, expect, test, vi } from "vitest";
import {
  retryChromiumStartup,
  runWithCleanup,
  waitForChromiumDevtoolsUrl,
} from "../page-fetch-startup.ts";

async function failedChromium(
  script: string,
  args: readonly string[],
): Promise<Error> {
  const child = Bun.spawn([process.execPath, "-e", script, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const controller = new AbortController();
  let failure: unknown;
  try {
    await waitForChromiumDevtoolsUrl(child, controller.signal);
  } catch (error) {
    failure = error;
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
  if (failure instanceof Error) {
    return failure;
  }
  throw new Error("Expected Chromium startup to fail");
}

async function startupFailure(
  operation: () => Promise<never>,
): Promise<AggregateError> {
  const failure = await retryChromiumStartup(
    operation,
    new AbortController().signal,
    () => Promise.resolve(),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (failure instanceof AggregateError) {
    return failure;
  }
  throw new Error("Expected an aggregate startup failure");
}

describe("Chromium startup", () => {
  test("reports the exit code and byte-bounded stderr tail", async () => {
    const prefix = "😀".repeat(5_000);
    const error = await failedChromium(
      'await Bun.write(Bun.stderr, Bun.argv[1] + "RESOURCE LIMIT\\n"); process.exit(23)',
      [prefix],
    );

    expect(error.name).toBe("ChromiumStartupError");
    expect(error.message).toContain("exit code 23, signal none");
    expect(error.message).toContain("Stderr tail:");
    expect(error.message).toContain("RESOURCE LIMIT");
    expect(error.message).not.toContain(prefix);
    const diagnostic = error.message.split("Stderr tail: ")[1];
    expect(diagnostic).toBeDefined();
    expect(Buffer.byteLength(diagnostic ?? "", "utf8")).toBeLessThanOrEqual(
      4_096,
    );
  });

  test("reports a terminating signal and empty stderr", async () => {
    const error = await failedChromium(
      'process.kill(process.pid, "SIGTERM")',
      [],
    );

    expect(error.message).toContain("exit code null, signal SIGTERM");
    expect(error.message).toContain("Stderr tail: <empty>");
  });

  test("retries one startup failure after a bounded backoff", async () => {
    const attempts: number[] = [];
    const wait = vi.fn(() => Promise.resolve());
    const controller = new AbortController();
    const startupError = (): Promise<never> =>
      failedChromium("process.exit(1)", []).then((error) =>
        Promise.reject(error),
      );
    const result = await retryChromiumStartup(
      () => {
        attempts.push(attempts.length + 1);
        return attempts.length === 1
          ? startupError()
          : Promise.resolve("ready");
      },
      controller.signal,
      wait,
    );

    expect(result).toBe("ready");
    expect(attempts).toEqual([1, 2]);
    expect(wait).toHaveBeenCalledWith(500, controller.signal);
  });

  test("preserves startup failures through rejected cleanup and retries", async () => {
    let attempts = 0;
    const operation = (): Promise<never> =>
      runWithCleanup(
        async () => {
          attempts += 1;
          throw await failedChromium(
            `console.error("launch ${String(attempts)} failed"); process.exit(${String(attempts)})`,
            [],
          );
        },
        () => Promise.reject(new Error(`cleanup ${String(attempts)} failed`)),
      );

    const failure = await startupFailure(operation);

    expect(attempts).toBe(2);
    expect(failure.message).toContain("launch 1 failed");
    expect(failure.message).toContain("launch 2 failed");
    expect(failure.errors).toMatchObject([
      {
        cause: { message: "cleanup 1 failed" },
        name: "ChromiumStartupError",
      },
      {
        cause: { message: "cleanup 2 failed" },
        name: "ChromiumStartupError",
      },
    ]);
  });

  test("reports both startup failures without retrying other errors", async () => {
    const first = await failedChromium(
      'console.error("first launch failed"); process.exit(1)',
      [],
    );
    const second = await failedChromium(
      'console.error("second launch failed"); process.exit(2)',
      [],
    );
    const operation = vi
      .fn<() => Promise<never>>()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second);

    const failure = await startupFailure(operation);
    expect(failure).toMatchObject({
      errors: [{}, {}],
    });
    expect(failure.message).toContain(
      "Chromium failed to start after two attempts",
    );
    expect(failure.message).toContain("Attempt 1:");
    expect(failure.message).toContain("first launch failed");
    expect(failure.message).toContain("Attempt 2:");
    expect(failure.message).toContain("second launch failed");
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBeInstanceOf(Error);
    expect(failure.errors[1]).toBeInstanceOf(Error);
    if (
      !(failure.errors[0] instanceof Error) ||
      !(failure.errors[1] instanceof Error)
    ) {
      throw new Error("Expected both startup failures to be errors");
    }
    expect(failure.errors[0].message).toContain("first launch failed");
    expect(failure.errors[1].message).toContain("second launch failed");

    const unrelated = vi.fn(() => Promise.reject(new Error("bad URL")));
    await expect(
      retryChromiumStartup(unrelated, new AbortController().signal),
    ).rejects.toThrow("bad URL");
    expect(unrelated).toHaveBeenCalledOnce();
  });
});
