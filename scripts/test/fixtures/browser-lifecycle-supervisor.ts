import { publishBrowserLifecycleReport } from "./browser-lifecycle-report.ts";

const rootDirectory = process.env["Q_MUSH_BROWSER_PROBE_ROOT"];
const lifecycleProbe = process.env["Q_MUSH_BROWSER_PROBE_SCRIPT"];
const reportPath = process.env["Q_MUSH_BROWSER_PROBE_REPORT"];
const realBun = process.env["Q_MUSH_BROWSER_REAL_BUN"];
if (
  rootDirectory === undefined ||
  lifecycleProbe === undefined ||
  reportPath === undefined ||
  realBun === undefined
) {
  throw new Error("Browser lifecycle supervisor requires probe paths");
}

const browserTests = Bun.spawn(
  [realBun, "run", "--no-orphans", "scripts/test-browser.ts"],
  {
    cwd: rootDirectory,
    env: {
      ...process.env,
      Q_MUSH_BROWSER_EXECUTABLE: process.env["Q_MUSH_BROWSER_EXECUTABLE"],
      Q_MUSH_BROWSER_PROBE_SCRIPT: lifecycleProbe,
      Q_MUSH_BROWSER_PROBE_REPORT: reportPath,
    },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  },
);
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
