import type { AgentRecordedMessage } from "../shared/agent-loop.ts";
import type {
  AgentSessionUsageUpdate,
  RestartHandoff,
} from "../shared/session-model.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";

export type RuntimeMessageParameters = readonly [
  sessionId: string,
  messages: readonly AgentRecordedMessage[],
  now: number,
  generation: number,
];

export type RuntimeCompactionParameters = readonly [
  sessionId: string,
  summary: string,
  usage: CompactionUsage,
  now: number,
  generation: number,
  startedAt: number,
];

export type RuntimeTerminalMessageParameters = readonly [
  ...RuntimeMessageParameters,
  restartHandoff: RestartHandoff | null,
  usage?: AgentSessionUsageUpdate,
];

export type RuntimeAppendMessageParameters = readonly [
  ...RuntimeMessageParameters,
  usage?: AgentSessionUsageUpdate,
];

export type RuntimeMessageWriteOptions =
  | {
      readonly kind: "terminal";
      readonly restartHandoff: RestartHandoff | null;
      readonly usage?: AgentSessionUsageUpdate;
    }
  | { readonly kind: "append"; readonly usage?: AgentSessionUsageUpdate };

export function runtimeUsageOption(
  usage: AgentSessionUsageUpdate | undefined,
): { readonly usage?: AgentSessionUsageUpdate } {
  return usage === undefined ? {} : { usage };
}
