import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type {
  AgentSessionDetail,
  AgentSessionUsageUpdate,
} from "../shared/session-model.ts";

export type SessionRecordedOutput = readonly [
  messages: readonly AgentRecordedMessage[],
  usage?: AgentSessionUsageUpdate,
];

export type SessionTerminalOutput = readonly [
  messages: SessionRecordedOutput[0],
  restartHandoff: AgentSessionDetail["restartHandoff"],
  usage?: SessionRecordedOutput[1],
];
