const reportPath = process.env["Q_MUSH_BROWSER_PROBE_REPORT"];
const realBun = process.env["Q_MUSH_BROWSER_REAL_BUN"];
if (reportPath === undefined || realBun === undefined) {
  throw new Error("Browser lifecycle Bun shim requires probe paths");
}

const invocation = process.argv.slice(2);
const runnerCommand = [
  "--no-orphans",
  "run",
  "--bun",
  "vitest",
  "run",
  "--config",
  "vitest.browser.config.ts",
];
if (!runnerCommand.every((argument, index) => invocation[index] === argument)) {
  throw new Error(
    `Browser lifecycle Bun shim received invalid arguments: ${JSON.stringify(process.argv)}`,
  );
}

const probe = process.env["Q_MUSH_BROWSER_PROBE_SCRIPT"];
if (probe === undefined) throw new Error("Missing browser lifecycle probe");
await Bun.write(
  `${reportPath}.runner`,
  JSON.stringify({ runnerPid: process.pid }),
);
const browser = Bun.spawn([realBun, probe, reportPath], {
  stderr: "ignore",
  stdin: "ignore",
  stdout: "ignore",
});
await browser.exited;
