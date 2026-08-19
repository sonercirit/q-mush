import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BROWSER_LAUNCH_REPORT = "Q_MUSH_BROWSER_LAUNCH_REPORT";

interface BrowserTestProcess {
  readonly exited: Promise<number>;
  readonly kill: (signal?: number | NodeJS.Signals) => void;
  readonly signalCode?: NodeJS.Signals | null;
}

export interface BrowserTestDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly spawn: (
    command: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly stderr: "inherit";
      readonly stdin: "inherit";
      readonly stdout: "inherit";
    },
  ) => BrowserTestProcess;
}

const defaultDependencies: BrowserTestDependencies = {
  executable: process.execPath,
  spawn(command, options) {
    return Bun.spawn([...command], options);
  },
};

function headlessEnvironment(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...base,
    PWDEBUG: "0",
  };
  // Never inherit environment controls used by browser-launch probes.
  Reflect.deleteProperty(environment, BROWSER_LAUNCH_REPORT);
  return environment;
}

export async function runBrowserTests(
  arguments_: readonly string[],
  dependencies: BrowserTestDependencies = defaultDependencies,
): Promise<number> {
  // Treat matching tokens anywhere as config flags, even where Vitest might
  // interpret one as a value: the launcher deliberately fails closed rather
  // than risk allowing an ambiguous argument sequence to replace its policy.
  if (
    arguments_.some(
      (argument) =>
        argument === "--config" ||
        argument.startsWith("--config=") ||
        argument === "-c" ||
        argument.startsWith("-c=") ||
        argument === "--configLoader" ||
        argument.startsWith("--configLoader=") ||
        argument === "--browser.provider" ||
        argument.startsWith("--browser.provider="),
    )
  ) {
    throw new Error("Browser tests do not accept Vitest config overrides");
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const browserTests = dependencies.spawn(
    [
      dependencies.executable,
      "--no-orphans",
      "run",
      "--bun",
      "vitest",
      "run",
      "--config",
      join(root, "vitest.browser.config.ts"),
      "--configLoader=runner",
      ...arguments_,
    ],
    {
      cwd: root,
      env: headlessEnvironment(dependencies.environment),
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    },
  );

  const forwardSignal = (signal: NodeJS.Signals): void => {
    browserTests.kill(signal);
  };
  const forwardInterrupt = (): void => {
    forwardSignal("SIGINT");
  };
  const forwardTermination = (): void => {
    forwardSignal("SIGTERM");
  };
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    const exitCode = await browserTests.exited;
    return browserTests.signalCode ? 1 : exitCode;
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
  }
}
