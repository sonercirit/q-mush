import { readAgentFile, type AgentFile } from "../shared/agent-file.ts";

export function storedAgentFile(stored: {
  readonly agentFileContent: string | null;
  readonly agentFileName: string | null;
}): AgentFile | null {
  return readAgentFile(
    stored.agentFileContent === null && stored.agentFileName === null
      ? null
      : { content: stored.agentFileContent, name: stored.agentFileName },
  );
}
