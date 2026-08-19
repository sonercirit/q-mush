import { join } from "node:path";
import { expect, test } from "vitest";
import {
  runBrowserTests,
  type BrowserTestDependencies,
} from "../test-browser-runner.ts";

const ROOT_DIRECTORY = join(import.meta.dirname, "../..");

interface SpawnCall {
  readonly command: readonly string[];
  readonly options: Parameters<BrowserTestDependencies["spawn"]>[1];
}

function dependencyProbe(
  exitCode = 0,
  signalCode: NodeJS.Signals | null = null,
): {
  readonly calls: SpawnCall[];
  readonly dependencies: BrowserTestDependencies;
  readonly signals: (number | NodeJS.Signals | undefined)[];
} {
  const calls: SpawnCall[] = [];
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  const spawn: BrowserTestDependencies["spawn"] = (command, options) => {
    calls.push({ command, options });
    return {
      exited: Promise.resolve(exitCode),
      kill: (signal) => {
        signals.push(signal);
      },
      signalCode,
    };
  };
  return {
    calls,
    dependencies: { executable: "/pinned/bun", spawn },
    signals,
  };
}

test("browser launcher forwards filters while disabling inherited Playwright debug mode", async () => {
  const probe = dependencyProbe();
  const originalDebug = process.env["PWDEBUG"];
  process.env["PWDEBUG"] = "1";

  try {
    await expect(
      runBrowserTests(["session-detail", "--browser.headless=false"], {
        ...probe.dependencies,
        environment: {
          ...process.env,
          Q_MUSH_BROWSER_LAUNCH_REPORT: "/tmp/untrusted-report",
        },
      }),
    ).resolves.toBe(0);
  } finally {
    if (originalDebug === undefined) {
      delete process.env["PWDEBUG"];
    } else {
      process.env["PWDEBUG"] = originalDebug;
    }
  }

  expect(probe.calls).toHaveLength(1);
  expect(probe.calls[0]?.command).toEqual([
    "/pinned/bun",
    "--no-orphans",
    "run",
    "--bun",
    "vitest",
    "run",
    "--config",
    join(ROOT_DIRECTORY, "vitest.browser.config.ts"),
    "--configLoader=runner",
    "session-detail",
    "--browser.headless=false",
  ]);
  expect(probe.calls[0]?.options.cwd).toBe(ROOT_DIRECTORY);
  expect(probe.calls[0]?.options.env["PWDEBUG"]).toBe("0");
  expect(
    probe.calls[0]?.options.env["Q_MUSH_BROWSER_LAUNCH_REPORT"],
  ).toBeUndefined();
});

test("browser launcher rejects config shaping", async () => {
  for (const arguments_ of [
    ["--config", "other.ts"],
    ["--config=other.ts"],
    ["-c", "other.ts"],
    ["-c=other.ts"],
  ]) {
    const probe = dependencyProbe();
    await expect(
      runBrowserTests(arguments_, probe.dependencies),
    ).rejects.toThrow("do not accept Vitest config overrides");
    expect(probe.calls).toHaveLength(0);
  }
});

test("browser launcher preserves the child exit code", async () => {
  await expect(
    runBrowserTests([], dependencyProbe(7).dependencies),
  ).resolves.toBe(7);
});

test("browser launcher forwards termination signals", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const exited = Promise.withResolvers<number>();
    const signals: NodeJS.Signals[] = [];
    const dependencies: BrowserTestDependencies = {
      executable: "/pinned/bun",
      spawn: () => ({
        exited: exited.promise,
        kill: (received) => {
          if (typeof received === "string") signals.push(received);
        },
        signalCode: null,
      }),
    };
    const baseline = process.listenerCount(signal);
    const running = runBrowserTests([], dependencies);
    expect(process.listenerCount(signal)).toBe(baseline + 1);
    process.emit(signal);
    exited.resolve(0);
    await expect(running).resolves.toBe(0);
    expect(signals).toEqual([signal]);
    expect(process.listenerCount(signal)).toBe(baseline);
  }
});

test("browser launcher treats signal termination as failure", async () => {
  await expect(
    runBrowserTests([], dependencyProbe(0, "SIGTERM").dependencies),
  ).resolves.toBe(1);
});
