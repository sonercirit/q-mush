import { AGENT_FILE_NAMES, type AgentFile } from "../shared/agent-file.ts";
import {
  openSecureRunnerPath,
  resolveRunnerWorkspace,
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
  path: string,
  name: string,
  contained: boolean,
): Promise<AgentFile | undefined> {
  let opened: Awaited<ReturnType<typeof openSecureRunnerPath>>;

  try {
    opened = await openSecureRunnerPath(root, path, {}, contained);
  } catch (error) {
    if (isMissingPath(error)) {
      return undefined;
    }
    if (
      contained &&
      error instanceof Error &&
      error.message === "The requested path is outside the session workspace"
    ) {
      throw new Error("The agent file is outside the session workspace", {
        cause: error,
      });
    }
    throw error;
  }

  try {
    if (!opened.stats.isFile()) {
      throw new Error("The agent file is not a regular file");
    }
    return { content: await opened.handle.readFile("utf8"), name };
  } finally {
    await opened.handle.close();
  }
}

async function loadDefaultAgentFile(
  root: string,
  contained: boolean,
): Promise<AgentFile | null> {
  for (const name of AGENT_FILE_NAMES) {
    const file = await loadCandidate(root, name, name, contained);
    if (file !== undefined) {
      return file;
    }
  }
  return null;
}

export async function loadRunnerAgentFile(
  workingDirectory: string,
  customPath?: string,
  contained = false,
): Promise<AgentFile | null> {
  const root = await resolveRunnerWorkspace(workingDirectory);
  if (customPath === undefined) {
    return loadDefaultAgentFile(root, contained);
  }
  return (await loadCandidate(root, customPath, customPath, contained)) ?? null;
}
