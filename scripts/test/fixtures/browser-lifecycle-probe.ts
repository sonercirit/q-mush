import { publishBrowserLifecycleReport } from "./browser-lifecycle-report.ts";

const reportPath = process.argv[2];
if (reportPath === undefined) {
  throw new Error("Browser lifecycle probe requires a report path");
}

const browser = Bun.spawn(["/bin/sh", "-c", "exec sleep 600"], {
  detached: true,
  stderr: "ignore",
  stdin: "ignore",
  stdout: "ignore",
});
await publishBrowserLifecycleReport(reportPath, {
  browserPid: browser.pid,
  vitestPid: process.pid,
});
await browser.exited;
