import {
  readRunnerAgentFileOutput,
  RUNNER_AGENT_FILE_COMMAND,
  type AgentFile,
} from "./agent-file.ts";
import type { RunnerCommandBroker } from "./runner-command-broker.ts";
import type { AgentSessionDetail } from "./session-model.ts";

export async function loadSessionAgentFile(
  broker: RunnerCommandBroker,
  session: AgentSessionDetail,
  signal: AbortSignal,
): Promise<AgentFile | null> {
  const output = await broker.dispatch(
    {
      arguments: {},
      runnerId: session.runnerId,
      sessionId: session.id,
      tool: RUNNER_AGENT_FILE_COMMAND,
      workingDirectory: session.workingDirectory,
    },
    signal,
  );
  return readRunnerAgentFileOutput(output);
}
