import { fileURLToPath } from "node:url";
import {
  developmentRestartTriggerPath,
  prepareDevelopmentRestartTrigger,
  startDevelopmentServer,
  triggerDevelopmentRestart,
} from "./development-server.ts";
import { startDevelopmentSourceWatcher } from "./development-source-watcher.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const restartTriggerPath = developmentRestartTriggerPath(projectRoot);
await prepareDevelopmentRestartTrigger(restartTriggerPath);
const sourceWatcher = await startDevelopmentSourceWatcher({
  onChange: () => triggerDevelopmentRestart(restartTriggerPath),
  projectRoot,
});
const developmentServer = startDevelopmentServer({
  command: [process.execPath, "run", "sync-engine/index.ts"],
  cwd: projectRoot,
  restartTriggerPath,
});
console.log(
  "Watching production source and local environment files for graceful restarts.",
);
console.log("Run `bun run dev:restart` to request one explicitly.");
let exiting = false;

function shutDown(exitCode: number): void {
  if (exiting) {
    return;
  }

  exiting = true;
  sourceWatcher.stop();
  void developmentServer.stop().then(() => {
    process.exit(exitCode);
  });
}

process.on("SIGINT", () => {
  shutDown(130);
});
process.on("SIGTERM", () => {
  shutDown(143);
});
