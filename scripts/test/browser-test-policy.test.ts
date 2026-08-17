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
const PLAYWRIGHT_LAUNCH_PROBE = fileURLToPath(
  new URL("fixtures/playwright-launch-probe.mjs", import.meta.url),
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

function expectHeadlessBinaryArguments(arguments_: readonly string[]): void {
  const headlessFlags = new Set(["--no-orphans", "--bun", "vitest", "x"]);
  const argumentSet = new Set(arguments_);
  if (
    arguments_[1] === "scripts/test-browser.ts" ||
    ![...headlessFlags].every((argument) => argumentSet.has(argument))
  ) {
    throw new Error(
      "Browser probe expected Bun's guarded Vitest binary runner",
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
        `(${expectHeadlessBinaryArguments.toString()})(process.argv);\nawait import(${JSON.stringify(
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
      const exitCode = await probe.exited;
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

interface BrowserLifecycleReport {
  readonly descendantPid: number;
  readonly vitestPid: number;
}

async function readLifecycleReport(
  pathname: string,
): Promise<BrowserLifecycleReport | undefined> {
  if (!(await Bun.file(pathname).exists())) return undefined;

  const value: unknown = await Bun.file(pathname).json();
  if (
    !isRecord(value) ||
    !Number.isInteger(value["descendantPid"]) ||
    !Number.isInteger(value["vitestPid"])
  ) {
    throw new TypeError("Browser lifecycle probe returned invalid process IDs");
  }

  return {
    descendantPid: Number(value["descendantPid"]),
    vitestPid: Number(value["vitestPid"]),
  };
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
    const processStatus = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    const statusOffset = processStatus.lastIndexOf(") ") + 2;
    return processStatus[statusOffset] !== "Z";
  } catch (error) {
    return failUnlessMissingProcess(error);
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

const SUPPORTS_NO_ORPHANS =
  process.platform === "darwin" || process.platform === "linux";

test.runIf(SUPPORTS_NO_ORPHANS)(
  "no-orphans runner recursively cleans a PID-killed browser process",
  async () => {
    await withTemporaryDirectory(
      "q-mush-browser-lifecycle-probe-",
      async (directory) => {
        const executable = join(directory, "bun");
        const reportPath = join(directory, "processes.json");
        const supervisorPath = join(directory, "supervisor.ts");
        await writeBunExecutable(
          executable,
          `const descendant = Bun.spawn(
  [process.execPath, "--no-orphans", "-e", "await new Promise(() => {})"],
  { stderr: "ignore", stdin: "ignore", stdout: "ignore" },
);
await Bun.write(
  ${JSON.stringify(reportPath)},
  JSON.stringify({ descendantPid: descendant.pid, vitestPid: process.pid }),
);
await new Promise(() => {});
`,
        );
        await writeFile(
          supervisorPath,
          `const browserTests = Bun.spawn([
  process.execPath,
  "run",
  "--no-orphans",
  ${JSON.stringify(executable)},
]);
await Bun.write(${JSON.stringify(
            join(directory, "browser-process.json"),
          )}, JSON.stringify({ pid: browserTests.pid }));
await browserTests.exited;
`,
        );
        const supervisor = Bun.spawn([process.execPath, supervisorPath], {
          detached: true,
          stderr: "pipe",
          stdin: "ignore",
          stdout: "pipe",
        });
        const errors = new Response(supervisor.stderr).text();
        const output = new Response(supervisor.stdout).text();
        let report: BrowserLifecycleReport | undefined;

        try {
          await expect
            .poll(
              async () => {
                report = await readLifecycleReport(reportPath);
                if (report === undefined && supervisor.exitCode !== null) {
                  const [stderr, stdout] = await Promise.all([errors, output]);
                  throw new Error(
                    `Browser lifecycle probe exited before starting: ${stderr}${stdout}`,
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
          const browserProcess: unknown = await Bun.file(
            join(directory, "browser-process.json"),
          ).json();
          if (
            !isRecord(browserProcess) ||
            !Number.isInteger(browserProcess["pid"])
          ) {
            throw new TypeError(
              "Browser lifecycle supervisor returned an invalid PID",
            );
          }
          const browserPid = Number(browserProcess["pid"]);
          expect(
            await Promise.all([
              processIsRunning(browserPid),
              processIsRunning(report.vitestPid),
              processIsRunning(report.descendantPid),
            ]),
          ).toEqual([true, true, true]);

          killProcess(browserPid);

          await expect
            .poll(
              async () =>
                (
                  await Promise.all(
                    [
                      browserPid,
                      report?.vitestPid,
                      report?.descendantPid,
                    ].flatMap((pid) =>
                      pid === undefined ? [] : [processIsRunning(pid)],
                    ),
                  )
                ).some(Boolean),
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
  const actions = stepRecords.flatMap((step) =>
    typeof step["uses"] === "string" ? [step["uses"]] : [],
  );

  expect(actions).not.toContain("actions/setup-node@v6");
  expect(configuration.devDependencies.get("playwright")).toBe("1.62.1");
  expect(configuration.devDependencies.get("vitest")).toBe("4.1.10");
  expect(configuration.scripts.get("test:browser")).toBe(
    "bun run --no-orphans scripts/test-browser.ts",
  );
  expect(configuration.scripts.get("test")).toBe(
    "bun run test:unit && bun run test:browser",
  );
  expect(commands).toContain("bun run test:browser");
});
