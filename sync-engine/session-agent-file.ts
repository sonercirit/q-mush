import {
  readRunnerAgentFileOutput,
  RUNNER_AGENT_FILE_COMMAND,
  type AgentFile,
} from "../shared/agent-file.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export async function loadSessionAgentFile(
  broker: RunnerCommandBroker,
  session: AgentSessionDetail,
  signal: AbortSignal,
): Promise<AgentFile | null> {
  const result = await broker.dispatch(
    {
      arguments: {},
      runnerId: session.runnerId,
      sessionId: session.id,
      tool: RUNNER_AGENT_FILE_COMMAND,
      workingDirectory: session.workingDirectory,
    },
    signal,
  );
  return readRunnerAgentFileOutput(result.output);
}
