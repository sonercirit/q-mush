import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_FILE_NAMES,
  type AgentFile,
  type AgentFileName,
} from "../shared/agent-file.ts";
import {
  resolveRunnerWorkspace,
  runnerPathIsWithin,
} from "./runner-workspace.ts";

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function loadCandidate(
  root: string,
  name: AgentFileName,
): Promise<AgentFile | undefined> {
  let path: string;

  try {
    path = await realpath(join(root, name));
  } catch (error) {
    if (isMissingPath(error)) {
      return undefined;
    }

    throw error;
  }

  if (!runnerPathIsWithin(root, path)) {
    throw new Error("The agent file is outside the session workspace");
  }

  const details = await stat(path);

  if (!details.isFile()) {
    return undefined;
  }

  return { content: await readFile(path, "utf8"), name };
}

export async function loadRunnerAgentFile(
  workingDirectory: string,
): Promise<AgentFile | null> {
  const root = await resolveRunnerWorkspace(workingDirectory);

  for (const name of AGENT_FILE_NAMES) {
    const file = await loadCandidate(root, name);

    if (file !== undefined) {
      return file;
    }
  }

  return null;
}
