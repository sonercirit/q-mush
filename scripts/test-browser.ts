import { runScript } from "./script-entry.ts";
import { runBrowserTests } from "./test-browser-runner.ts";

await runScript(() => runBrowserTests(process.argv.slice(2)));
