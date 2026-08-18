import { publishBrowserLifecycleReport } from "./browser-lifecycle-report.ts";

const rootDirectory = process.env["Q_MUSH_BROWSER_PROBE_ROOT"];
const lifecycleProbe = process.env["Q_MUSH_BROWSER_PROBE_SCRIPT"];
const reportPath = process.env["Q_MUSH_BROWSER_PROBE_REPORT"];
const commandSource = process.env["Q_MUSH_BROWSER_TEST_COMMAND"];
if (
  rootDirectory === undefined ||
  lifecycleProbe === undefined ||
  reportPath === undefined ||
  commandSource === undefined
) {
  throw new Error("Browser lifecycle supervisor requires probe paths");
}

const command: unknown = JSON.parse(commandSource);
if (
  !Array.isArray(command) ||
  !command.every((item) => typeof item === "string")
) {
  throw new TypeError("Browser lifecycle supervisor requires a command");
}

const browserTests = Bun.spawn(command, {
  cwd: rootDirectory,
  env: {
    ...process.env,
    PATH: process.env["Q_MUSH_BROWSER_PROBE_PATH"],
    Q_MUSH_BROWSER_PROBE_PATH: process.env["Q_MUSH_BROWSER_PROBE_PATH"],
    Q_MUSH_BROWSER_PROBE_SCRIPT: lifecycleProbe,
    Q_MUSH_BROWSER_REAL_BUN: process.env["Q_MUSH_BROWSER_REAL_BUN"],
    Q_MUSH_BROWSER_PROBE_REPORT: reportPath,
  },
  stderr: "pipe",
  stdin: "ignore",
  stdout: "pipe",
});
await publishBrowserLifecycleReport(`${reportPath}.launcher`, {
  launcherPid: browserTests.pid,
});
const [exitCode, stderr, stdout] = await Promise.all([
  browserTests.exited,
  new Response(browserTests.stderr).text(),
  new Response(browserTests.stdout).text(),
]);
if (exitCode !== 0) {
  throw new Error(`Browser lifecycle command failed: ${stderr}${stdout}`);
}
