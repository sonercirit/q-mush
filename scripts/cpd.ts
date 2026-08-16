import { resolve } from "node:path";
import { runCpd } from "./cpd-run.ts";
import { runScript } from "./script-entry.ts";

await runScript(() =>
  runCpd(resolve(import.meta.dirname, ".."), process.argv.slice(2)),
);
