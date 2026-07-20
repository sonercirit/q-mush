import { fileURLToPath } from "node:url";
import {
  developmentRestartTriggerPath,
  triggerDevelopmentRestart,
} from "./development-server.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
await triggerDevelopmentRestart(developmentRestartTriggerPath(projectRoot));
console.log("Requested a Q Mush development restart.");
