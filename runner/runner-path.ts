import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export function expandRunnerHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  return path.startsWith(`~${sep}`) ? resolve(homedir(), path.slice(2)) : path;
}
