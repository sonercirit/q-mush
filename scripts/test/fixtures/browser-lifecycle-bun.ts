import { rename } from "node:fs/promises";

const reportPath = process.env["Q_MUSH_BROWSER_PROBE_REPORT"];
const realBun = process.env["Q_MUSH_BROWSER_REAL_BUN"];
const rootDirectory = process.env["Q_MUSH_BROWSER_PROBE_ROOT"];
if (
  reportPath === undefined ||
  realBun === undefined ||
  rootDirectory === undefined
) {
  throw new Error("Browser lifecycle Bun shim requires probe paths");
}

const invocation = process.argv.slice(2);
const packageCommand = ["run", "--no-orphans", "scripts/test-browser.ts"];
const runnerCommand = [
  "--no-orphans",
  "run",
  "--bun",
  "vitest",
  "run",
  "--config",
  "vitest.browser.config.ts",
];
const matches = (expected: readonly string[]): boolean =>
  expected.every((argument, index) => invocation[index] === argument);

if (matches(packageCommand)) {
  const launcher = Bun.spawn(
    [realBun, "run", "--no-orphans", "scripts/test-browser.ts"],
    {
      cwd: rootDirectory,
      env: process.env,
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    },
  );
  await launcher.exited;
} else if (matches(runnerCommand)) {
  const probe = process.env["Q_MUSH_BROWSER_PROBE_SCRIPT"];
  if (probe === undefined) throw new Error("Missing browser lifecycle probe");
  const temporaryReport = `${reportPath}.runner.${String(process.pid)}.tmp`;
  await Bun.write(temporaryReport, JSON.stringify({ runnerPid: process.pid }));
  await rename(temporaryReport, `${reportPath}.runner`);
  const browser = Bun.spawn([realBun, probe, reportPath], {
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  await browser.exited;
} else {
  throw new Error(
    `Browser lifecycle Bun shim received invalid arguments: ${JSON.stringify(process.argv)}`,
  );
}
