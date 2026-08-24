import type { AgentFile } from "../shared/agent-file.ts";
import type {
  AgentSessionUsageUpdate,
  RestartHandoff,
} from "../shared/session-model.ts";
import {
  runtimeUsageOption,
  type RuntimeAppendMessageParameters,
  type RuntimeCompactionParameters,
  type RuntimeMessageParameters,
  type RuntimeMessageWriteOptions,
  type RuntimeTerminalMessageParameters,
} from "./session-runtime-write-options.ts";
import type { SessionStoreWriteResources } from "./session-store-resources.ts";
import {
  appendRuntimeAgentMessages,
  appendRuntimeErrorMessage,
  commitRuntimeTerminal,
  compactRuntimeConversation,
  compactRuntimeTerminal,
  markRuntimeStepStart,
  setRuntimeAgentFile,
  setRuntimeModelMetadata,
  settleRuntimeFailure,
  updateRuntimeUsage,
} from "./session-store-runtime-writes.ts";

interface SessionStoreRuntimeResources {
  readonly write: () => SessionStoreWriteResources;
}

function runtimeTarget(
  resources: SessionStoreRuntimeResources,
  sessionId: string,
  now: number,
  generation: number,
) {
  return {
    generation,
    now,
    resources: resources.write(),
    sessionId,
  };
}

function writeAgentMessages(
  resources: SessionStoreRuntimeResources,
  parameters: RuntimeMessageParameters,
  options: RuntimeMessageWriteOptions,
): void {
  const [sessionId, messages, now, generation] = parameters;
  const target = {
    ...runtimeTarget(resources, sessionId, now, generation),
    messages,
  };
  if (options.kind === "terminal") {
    commitRuntimeTerminal({
      ...target,
      restartHandoff: options.restartHandoff,
      ...runtimeUsageOption(options.usage),
    });
    return;
  }
  appendRuntimeAgentMessages({
    ...target,
    ...runtimeUsageOption(options.usage),
  });
}

function compactRuntime(
  resources: SessionStoreRuntimeResources,
  parameters:
    | RuntimeCompactionParameters
    | readonly [
        ...RuntimeCompactionParameters,
        restartHandoff: RestartHandoff | null,
      ],
): void {
  const [
    sessionId,
    summary,
    usage,
    now,
    generation,
    startedAt,
    restartHandoff,
  ] = parameters;
  const target = runtimeTarget(resources, sessionId, now, generation);
  if (restartHandoff === undefined) {
    compactRuntimeConversation({ ...target, startedAt, summary, usage });
  } else {
    compactRuntimeTerminal({
      ...target,
      restartHandoff,
      startedAt,
      summary,
      usage,
    });
  }
}

export interface RuntimeModelMetadata {
  readonly adaptiveThinking: boolean | null;
  readonly maxOutputTokens: number | null;
}

export interface SessionStoreRuntime {
  readonly appendRuntimeAgentMessages: (
    ...parameters: RuntimeAppendMessageParameters
  ) => void;
  readonly appendRuntimeErrorMessage: (
    sessionId: string,
    content: string,
    now: number,
    generation: number,
  ) => void;
  readonly commitRuntimeTerminal: (
    ...parameters: RuntimeTerminalMessageParameters
  ) => void;
  readonly compactRuntimeConversation: (
    ...parameters: RuntimeCompactionParameters
  ) => void;
  readonly compactRuntimeTerminal: (
    ...parameters: readonly [
      ...RuntimeCompactionParameters,
      restartHandoff: RestartHandoff | null,
    ]
  ) => void;
  readonly markRuntimeStepStart: (
    sessionId: string,
    now: number,
    generation: number,
  ) => void;
  readonly setRuntimeAgentFile: (
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
    generation: number,
  ) => void;
  readonly setRuntimeModelMetadata: (
    sessionId: string,
    credentialId: string,
    metadata: RuntimeModelMetadata,
    now: number,
    generation: number,
  ) => void;
  readonly settleRuntimeFailure: (
    sessionId: string,
    content: string,
    now: number,
    generation: number,
  ) => boolean;
  readonly updateRuntimeUsage: (
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
    generation: number,
  ) => void;
}

export function createSessionStoreRuntime(
  write: () => SessionStoreWriteResources,
): SessionStoreRuntime {
  const resources = { write };
  const target = (sessionId: string, now: number, generation: number) =>
    runtimeTarget(resources, sessionId, now, generation);
  return {
    appendRuntimeAgentMessages: (
      sessionId,
      messages,
      now,
      generation,
      usage,
    ) => {
      writeAgentMessages(resources, [sessionId, messages, now, generation], {
        kind: "append",
        ...runtimeUsageOption(usage),
      });
    },
    appendRuntimeErrorMessage: (sessionId, content, now, generation) => {
      appendRuntimeErrorMessage({
        content,
        ...target(sessionId, now, generation),
      });
    },
    commitRuntimeTerminal: (
      sessionId,
      messages,
      now,
      generation,
      restartHandoff,
      usage,
    ) => {
      writeAgentMessages(resources, [sessionId, messages, now, generation], {
        kind: "terminal",
        restartHandoff,
        ...runtimeUsageOption(usage),
      });
    },
    compactRuntimeConversation: (...parameters) => {
      compactRuntime(resources, parameters);
    },
    compactRuntimeTerminal: (...parameters) => {
      compactRuntime(resources, parameters);
    },
    markRuntimeStepStart: (sessionId, now, generation) => {
      markRuntimeStepStart(target(sessionId, now, generation));
    },
    setRuntimeAgentFile: (sessionId, agentFile, now, generation) => {
      setRuntimeAgentFile({ agentFile, ...target(sessionId, now, generation) });
    },
    setRuntimeModelMetadata: (
      sessionId,
      credentialId,
      metadata,
      now,
      generation,
    ) => {
      setRuntimeModelMetadata({
        credentialId,
        ...metadata,
        ...target(sessionId, now, generation),
      });
    },
    settleRuntimeFailure: (sessionId, content, now, generation) =>
      settleRuntimeFailure({ content, ...target(sessionId, now, generation) }),
    updateRuntimeUsage: (sessionId, input, now, generation) => {
      updateRuntimeUsage({ ...target(sessionId, now, generation), input });
    },
  };
}
