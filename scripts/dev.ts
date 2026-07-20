import { fileURLToPath } from "node:url";
import { startDevelopmentServer } from "./development-server.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const developmentServer = startDevelopmentServer({
  command: [process.execPath, "run", "src/index.ts"],
  cwd: projectRoot,
  watchPaths: [fileURLToPath(new URL("../src", import.meta.url))],
});
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
