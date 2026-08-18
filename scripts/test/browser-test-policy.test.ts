import { chmod, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type LaunchOptions } from "playwright";
import { afterEach, expect, test } from "vitest";
import { createVitest, parseCLI } from "vitest/node";
import { isRecord } from "../../shared/validation.ts";
import { withTemporaryDirectory } from "./temporary-directory.ts";

const ROOT_DIRECTORY = join(import.meta.dirname, "../..");
const BROWSER_TEST_ENTRY = join(ROOT_DIRECTORY, "scripts", "test-browser.ts");
const BROWSER_LIFECYCLE_BUN = fileURLToPath(
  new URL("fixtures/browser-lifecycle-bun.ts", import.meta.url),
);
const BROWSER_LIFECYCLE_PROBE = fileURLToPath(
  new URL("fixtures/browser-lifecycle-probe.ts", import.meta.url),
);
const PLAYWRIGHT_LAUNCH_PROBE = fileURLToPath(
  new URL("fixtures/playwright-launch-probe.ts", import.meta.url),
);

function restorePlaywrightLaunch(): void {
  chromium.launch = ORIGINAL_PLAYWRIGHT_LAUNCH;
}

const ORIGINAL_PLAYWRIGHT_LAUNCH = chromium.launch.bind(chromium);

afterEach(restorePlaywrightLaunch);

interface PackageConfiguration {
  readonly devDependencies: Map<string, string>;
  readonly scripts: Map<string, string>;
}

function stringMap(value: unknown, label: string): Map<string, string> {
  if (!isRecord(value)) {
    throw new TypeError(`package.json must define string ${label}`);
  }

  const entries: [string, string][] = [];
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new TypeError(`package.json must define string ${label}`);
    }
    entries.push([name, item]);
  }

  return new Map(entries);
}

function packageConfiguration(source: string): PackageConfiguration {
  const value: unknown = JSON.parse(source);

  return {
    devDependencies: stringMap(
      isRecord(value) ? value["devDependencies"] : undefined,
      "devDependencies",
    ),
    scripts: stringMap(
      isRecord(value) ? value["scripts"] : undefined,
      "scripts",
    ),
  };
}

async function browserLaunchProbe(
  arguments_: readonly string[],
): Promise<LaunchOptions> {
  // This deliberately intercepts the public launch method used by pinned Vitest
  // 4.1.10. Its focused test must fail closed before either package is upgraded.
  const launch = Promise.withResolvers<LaunchOptions>();
  chromium.launch = (options) => {
    launch.resolve(options ?? {});
    return Promise.reject(new Error("Browser launch captured"));
  };
  const parsed = parseCLI([
    "vitest",
    "run",
    "--config",
    "vitest.browser.config.ts",
    ...arguments_,
  ]);
  const vitest = await createVitest("test", parsed.options);

  try {
    const [project] = vitest.projects;
    if (project === undefined) {
      throw new Error("Browser policy probe found no Vitest project");
    }
    const standalone = vitest.standalone();
    await expect(standalone).rejects.toThrow("Browser launch captured");
    expect(project.browser?.provider.name).toBe("playwright");
    expect(project.config.browser.name).toBe("chromium");
    return await launch.promise;
  } finally {
    await vitest.close();
  }
}

test("ordinary Chromium launches stay headless under adversarial overrides", async () => {
  await expect(browserLaunchProbe([])).resolves.toMatchObject({
    headless: true,
  });
  await expect(
    browserLaunchProbe(["--browser.headless=false"]),
  ).resolves.toMatchObject({ headless: true });
});

interface PlaywrightLaunchResult {
  readonly configuredHeadless: boolean;
  readonly effectiveHeadless: boolean;
  readonly playwrightDebug: string;
  readonly workingDirectory: string;
}

function expectGuardedVitestArguments(arguments_: readonly string[]): void {
  const expected = ["--no-orphans", "run", "--bun", "vitest"];
  const commandOffset = arguments_.findIndex(
    (argument) => argument === expected[0],
  );
  if (
    commandOffset < 0 ||
    expected.some(
      (argument, index) => arguments_[commandOffset + index] !== argument,
    )
  ) {
    throw new Error(
      `Browser probe expected Bun's guarded Vitest binary runner: ${JSON.stringify(arguments_)}`,
    );
  }
}

async function writeBunExecutable(
  pathname: string,
  source: string,
): Promise<void> {
  await writeFile(pathname, `#!${process.execPath}\n${source}`);
  await chmod(pathname, 0o755);
}

async function runGuardedPlaywrightLaunchProbe(): Promise<PlaywrightLaunchResult> {
  return withTemporaryDirectory(
    "q-mush-browser-launch-probe-",
    async (directory) => {
      const executable = join(directory, "bun");
      const inheritedPath = process.env["PATH"] ?? "";
      await writeBunExecutable(
        executable,
        `(${expectGuardedVitestArguments.toString()})(process.argv);\nawait import(${JSON.stringify(
          PLAYWRIGHT_LAUNCH_PROBE,
        )});\n`,
      );
      const probe = Bun.spawn([process.execPath, BROWSER_TEST_ENTRY], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${inheritedPath}`,
          PWDEBUG: "1",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const output = new Response(probe.stdout).text();
      const errors = new Response(probe.stderr).text();
      const timeout = AbortSignal.timeout(5_000);
      const aborted = new Promise<never>((_resolve, reject) => {
        timeout.addEventListener(
          "abort",
          () => {
            reject(new Error("Playwright launch probe timed out"));
          },
          { once: true },
        );
      });
      let exitCode: number;
      try {
        exitCode = await Promise.race([probe.exited, aborted]);
      } finally {
        if (probe.exitCode === null) probe.kill();
        await probe.exited;
      }
      const [stdout, stderr] = await Promise.all([output, errors]);
      if (exitCode !== 1) {
        throw new Error(`Playwright launch probe failed: ${stderr}`);
      }
      const result = /PLAYWRIGHT_LAUNCH_PROBE=(\{[^\n]+\})/u.exec(stdout)?.[1];
      if (result === undefined) {
        throw new Error(`Playwright launch probe did not run: ${stderr}`);
      }
      const parsed: unknown = JSON.parse(result);
      if (
        !isRecord(parsed) ||
        typeof parsed["configuredHeadless"] !== "boolean" ||
        typeof parsed["effectiveHeadless"] !== "boolean" ||
        typeof parsed["playwrightDebug"] !== "string" ||
        typeof parsed["workingDirectory"] !== "string"
      ) {
        throw new TypeError(
          "Playwright launch probe returned an invalid result",
        );
      }
      return {
        configuredHeadless: parsed["configuredHeadless"],
        effectiveHeadless: parsed["effectiveHeadless"],
        playwrightDebug: parsed["playwrightDebug"],
        workingDirectory: parsed["workingDirectory"],
      };
    },
  );
}

test("shipped browser entrypoint defeats inherited Playwright debug mode", async () => {
  await expect(runGuardedPlaywrightLaunchProbe()).resolves.toEqual({
    configuredHeadless: true,
    effectiveHeadless: true,
    playwrightDebug: "0",
    workingDirectory: ROOT_DIRECTORY,
  });
});

test("package and CI structurally use the guarded browser launcher", async () => {
  const [packageSource, workflowSource] = await Promise.all([
    readFile(join(ROOT_DIRECTORY, "package.json"), "utf8"),
    readFile(join(ROOT_DIRECTORY, ".github/workflows/checks.yml"), "utf8"),
  ]);
  const configuration = packageConfiguration(packageSource);
  const workflow: unknown = Bun.YAML.parse(workflowSource);
  const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
  const tests = isRecord(jobs) ? jobs["tests"] : undefined;
  const steps = isRecord(tests) ? tests["steps"] : undefined;
  const stepRecords = Array.isArray(steps) ? steps.filter(isRecord) : [];
  const commands = stepRecords.flatMap((step) =>
    typeof step["run"] === "string" ? [step["run"]] : [],
  );
  const workflowJobs = isRecord(jobs)
    ? Object.values(jobs).filter(isRecord)
    : [];
  const workflowSteps = workflowJobs.flatMap((job) =>
    Array.isArray(job["steps"]) ? job["steps"].filter(isRecord) : [],
  );
  const actions = workflowSteps.flatMap((step) =>
    typeof step["uses"] === "string" ? [step["uses"]] : [],
  );

  expect(
    actions.some((action) => action.startsWith("actions/setup-node")),
  ).toBe(false);
  expect(
    configuration.devDependencies.get("playwright"),
    "Update the `<launching>` compatibility probe before Playwright",
  ).toBe("1.62.1");
  expect(
    configuration.devDependencies.get("vitest"),
    "Update the browser launch monkey patch before Vitest",
  ).toBe("4.1.10");
  expect(configuration.scripts.get("test:browser")).toBe(
    "bun run --no-orphans scripts/test-browser.ts",
  );
  expect(configuration.scripts.get("test")).toBe(
    "bun run test:unit && bun run test:browser",
  );
  expect(commands).toContain("bun run test:browser");
});

interface BrowserLifecycleReport {
  readonly browserPid: number;
  readonly launcherPid: number;
  readonly runnerPid: number;
  readonly vitestPid: number;
}

function isMissingProcessError(error: unknown): boolean {
  return (
    isRecord(error) && (error["code"] === "ENOENT" || error["code"] === "ESRCH")
  );
}

function failUnlessMissingProcess(error: unknown): false {
  if (isMissingProcessError(error)) return false;
  throw error;
}

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return failUnlessMissingProcess(error);
  }

  if (process.platform !== "linux") return true;

  try {
    const status = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    return status[status.lastIndexOf(") ") + 2] !== "Z";
  } catch (error) {
    return failUnlessMissingProcess(error);
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
}

async function readBrowserLifecycleReport(
  reportPath: string,
): Promise<BrowserLifecycleReport | undefined> {
  const processFile = Bun.file(reportPath);
  const launcherFile = Bun.file(`${reportPath}.launcher`);
  const runnerFile = Bun.file(`${reportPath}.runner`);
  if (
    !(await processFile.exists()) ||
    !(await launcherFile.exists()) ||
    !(await runnerFile.exists())
  ) {
    return undefined;
  }
  const processes: unknown = await processFile.json();
  const launcher: unknown = await launcherFile.json();
  const runner: unknown = await runnerFile.json();
  if (
    !isRecord(processes) ||
    !Number.isInteger(processes["browserPid"]) ||
    !Number.isInteger(processes["vitestPid"]) ||
    !isRecord(launcher) ||
    !Number.isInteger(launcher["launcherPid"]) ||
    !isRecord(runner) ||
    !Number.isInteger(runner["runnerPid"])
  ) {
    throw new TypeError("Browser lifecycle probe returned invalid process IDs");
  }
  return {
    browserPid: Number(processes["browserPid"]),
    launcherPid: Number(launcher["launcherPid"]),
    runnerPid: Number(runner["runnerPid"]),
    vitestPid: Number(processes["vitestPid"]),
  };
}

const SUPPORTS_NO_ORPHANS =
  process.platform === "darwin" || process.platform === "linux";

test.runIf(SUPPORTS_NO_ORPHANS)(
  "shipped launcher recursively cleans a detached non-Bun browser",
  async () => {
    await withTemporaryDirectory(
      "q-mush-browser-lifecycle-probe-",
      async (directory) => {
        const reportPath = join(directory, "processes.json");
        const executable = join(directory, "bun");
        await writeBunExecutable(
          executable,
          `await import(${JSON.stringify(BROWSER_LIFECYCLE_BUN)});\n`,
        );
        const packageSource = await readFile(
          join(ROOT_DIRECTORY, "package.json"),
          "utf8",
        );
        const browserCommand =
          packageConfiguration(packageSource).scripts.get("test:browser");
        if (browserCommand === undefined) {
          throw new Error("package.json must define test:browser");
        }
        const supervisor = Bun.spawn(
          [
            process.execPath,
            fileURLToPath(
              new URL(
                "fixtures/browser-lifecycle-supervisor.ts",
                import.meta.url,
              ),
            ),
          ],
          {
            cwd: directory,
            detached: true,
            env: {
              ...process.env,
              PATH: `${directory}${delimiter}${process.env["PATH"] ?? ""}`,
              Q_MUSH_BROWSER_PROBE_REPORT: reportPath,
              Q_MUSH_BROWSER_PROBE_ROOT: ROOT_DIRECTORY,
              Q_MUSH_BROWSER_PROBE_SCRIPT: BROWSER_LIFECYCLE_PROBE,
              Q_MUSH_BROWSER_PROBE_PATH: `${directory}${delimiter}${process.env["PATH"] ?? ""}`,
              Q_MUSH_BROWSER_REAL_BUN: process.execPath,
              Q_MUSH_BROWSER_TEST_COMMAND: JSON.stringify(
                browserCommand.split(" "),
              ),
            },
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
          },
        );
        const supervisorError = new Response(supervisor.stderr).text();
        const supervisorOutput = new Response(supervisor.stdout).text();
        let report: BrowserLifecycleReport | undefined;

        try {
          await expect
            .poll(
              async () => {
                report = await readBrowserLifecycleReport(reportPath);
                if (report === undefined && supervisor.exitCode !== null) {
                  const [stderr, stdout] = await Promise.all([
                    supervisorError,
                    supervisorOutput,
                  ]);
                  throw new Error(
                    `Browser lifecycle supervisor exited early: ${stderr}${stdout}`,
                  );
                }
                return report !== undefined;
              },
              { interval: 10, timeout: 5_000 },
            )
            .toBe(true);
          if (report === undefined) {
            throw new Error("Browser lifecycle probe did not start");
          }
          const activeReport = report;
          expect(new Set(Object.values(activeReport)).size).toBe(4);
          expect(
            await Promise.all(
              Object.values(activeReport).map(processIsRunning),
            ),
          ).toEqual([true, true, true, true]);

          killProcess(activeReport.launcherPid);

          await expect
            .poll(
              async () => {
                const running = await Promise.all(
                  Object.values(activeReport).map(processIsRunning),
                );
                return running.some(Boolean);
              },
              { interval: 10, timeout: 5_000 },
            )
            .toBe(false);
        } finally {
          killProcess(-supervisor.pid);
          await supervisor.exited;
        }
      },
    );
  },
);
