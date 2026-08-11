import { fileURLToPath } from "node:url";
import {
  developmentRestartTriggerPath,
  prepareDevelopmentRestartTrigger,
  startDevelopmentServer,
  triggerDevelopmentRestart,
} from "./development-server.ts";
import { createDevelopmentShutdown } from "./development-shutdown.ts";
import { startDevelopmentSourceWatcher } from "./development-source-watcher.ts";

const watchSources = process.argv.includes("--watch");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const restartTriggerPath = developmentRestartTriggerPath(projectRoot);
await prepareDevelopmentRestartTrigger(restartTriggerPath);
const sourceWatcher = watchSources
  ? await startDevelopmentSourceWatcher({
      onChange: () => triggerDevelopmentRestart(restartTriggerPath),
      projectRoot,
    })
  : undefined;
const developmentServer = startDevelopmentServer({
  command: [process.execPath, "run", "sync-engine/index.ts"],
  cwd: projectRoot,
  restartTriggerPath,
});
if (watchSources) {
  console.log(
    "Watching production source and local environment files for graceful restarts.",
  );
}
console.log("Run `bun run dev:restart` to request a graceful restart.");
const shutDown = createDevelopmentShutdown({
  developmentServer,
  stopSourceWatcher: () => {
    sourceWatcher?.stop();
  },
});

process.on("SIGINT", () => {
  shutDown(130);
});
process.on("SIGTERM", () => {
  shutDown(143);
});
