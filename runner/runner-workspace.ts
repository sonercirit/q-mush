import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { expandRunnerHome } from "./runner-path.ts";

export function runnerPathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

export async function resolveRunnerWorkspace(path: string): Promise<string> {
  const root = await realpath(expandRunnerHome(path));
  const details = await stat(root);

  if (!details.isDirectory()) {
    throw new Error("The session workspace is not a directory");
  }

  return root;
}
