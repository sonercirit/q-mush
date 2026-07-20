import { fileURLToPath } from "node:url";
import {
  developmentRestartTriggerPath,
  prepareDevelopmentRestartTrigger,
  startDevelopmentServer,
} from "./development-server.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const restartTriggerPath = developmentRestartTriggerPath(projectRoot);
await prepareDevelopmentRestartTrigger(restartTriggerPath);
const developmentServer = startDevelopmentServer({
  command: [process.execPath, "run", "src/index.ts"],
  cwd: projectRoot,
  restartTriggerPath,
});
console.log("Run `bun run dev:restart` to restart Q Mush and update runners.");
let exiting = false;

function shutDown(exitCode: number): void {
  if (exiting) {
    return;
  }

  exiting = true;
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
