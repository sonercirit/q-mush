import { join } from "node:path";
import { publishBrowserLifecycleReport } from "./browser-lifecycle-report.ts";

const requiredEnvironment = [
  "Q_MUSH_BROWSER_PROBE_REPORT",
  "Q_MUSH_BROWSER_REAL_BUN",
] as const;
const [reportPath, realBun] = requiredEnvironment.map(
  (name) => process.env[name],
);
if (reportPath === undefined || realBun === undefined) {
  throw new Error("Browser lifecycle Bun shim requires probe paths");
}

const invocation = process.argv.slice(2);
const configPath = join(
  process.env["Q_MUSH_BROWSER_PROBE_ROOT"] ?? "",
  "vitest.browser.config.ts",
);
const runnerCommand = [
  "--no-orphans",
  "run",
  "--bun",
  "vitest",
  "run",
  "--config",
  configPath,
  "--configLoader=runner",
];
if (!runnerCommand.every((argument, index) => invocation[index] === argument)) {
  throw new Error(
    `Browser lifecycle Bun shim received invalid arguments: ${JSON.stringify(process.argv)}`,
  );
}

const probe = process.env["Q_MUSH_BROWSER_PROBE_SCRIPT"];
if (probe === undefined) throw new Error("Missing browser lifecycle probe");
await publishBrowserLifecycleReport(`${reportPath}.runner`, {
  runnerPid: process.pid,
});
const browser = Bun.spawn([realBun, probe, reportPath], {
  stderr: "ignore",
  stdin: "ignore",
  stdout: "ignore",
});
await browser.exited;
