import { runBrowserTests } from "../../test-browser-runner.ts";

const executable = process.env["Q_MUSH_BROWSER_EXECUTABLE"];
if (executable === undefined) {
  throw new Error("Browser test runner probe requires an executable");
}

process.exitCode = await runBrowserTests(process.argv.slice(2), {
  executable,
  spawn: (command, options) => Bun.spawn([...command], options),
});
