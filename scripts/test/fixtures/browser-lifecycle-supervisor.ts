const rootDirectory = process.env["Q_MUSH_BROWSER_PROBE_ROOT"];
const lifecycleProbe = process.env["Q_MUSH_BROWSER_PROBE_SCRIPT"];
const reportPath = process.env["Q_MUSH_BROWSER_PROBE_REPORT"];
if (
  rootDirectory === undefined ||
  lifecycleProbe === undefined ||
  reportPath === undefined
) {
  throw new Error("Browser lifecycle supervisor requires probe paths");
}

const browserTests = Bun.spawn(
  [process.execPath, "run", "--no-orphans", "scripts/test-browser.ts"],
  {
    cwd: rootDirectory,
    env: {
      ...process.env,
      Q_MUSH_BROWSER_PROBE_SCRIPT: lifecycleProbe,
      Q_MUSH_BROWSER_PROBE_REPORT: reportPath,
    },
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  },
);
await Bun.write(
  `${reportPath}.launcher`,
  JSON.stringify({ launcherPid: browserTests.pid }),
);
await browserTests.exited;
