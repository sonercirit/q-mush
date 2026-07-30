import {
  readRunnerAgentFileOutput,
  RUNNER_AGENT_FILE_COMMAND,
  RUNNER_AGENT_FILE_PATH_ARGUMENT,
  type AgentFile,
} from "../shared/agent-file.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export async function loadSessionAgentFile(
  broker: RunnerCommandBroker,
  session: AgentSessionDetail,
  signal: AbortSignal,
  authorize: () => boolean,
): Promise<AgentFile | null> {
  const result = await broker.dispatch(
    {
      arguments:
        session.agentFilePath === null
          ? {}
          : { [RUNNER_AGENT_FILE_PATH_ARGUMENT]: session.agentFilePath },
      authorize,
      executionEnvironment: session.executionEnvironment,
      runnerId: session.runnerId,
      sessionId: session.id,
      tool: RUNNER_AGENT_FILE_COMMAND,
      workingDirectory: session.workingDirectory,
    },
    signal,
  );
  return readRunnerAgentFileOutput(result.output);
}
