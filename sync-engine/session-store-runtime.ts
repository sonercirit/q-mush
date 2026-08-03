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
  setRuntimeAgentFile,
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

export abstract class SessionStoreRuntime {
  protected abstract runtimeWriteResources(): SessionStoreWriteResources;

  #runtimeResources(): SessionStoreRuntimeResources {
    return { write: () => this.runtimeWriteResources() };
  }

  #target(sessionId: string, now: number, generation: number) {
    return runtimeTarget(this.#runtimeResources(), sessionId, now, generation);
  }

  setRuntimeAgentFile(
    sessionId: string,
    agentFile: AgentFile | null,
    now: number,
    generation: number,
  ): void {
    setRuntimeAgentFile({
      agentFile,
      ...this.#target(sessionId, now, generation),
    });
  }

  commitRuntimeTerminal(
    ...[
      sessionId,
      messages,
      now,
      generation,
      restartHandoff,
      usage,
    ]: RuntimeTerminalMessageParameters
  ): void {
    writeAgentMessages(
      this.#runtimeResources(),
      [sessionId, messages, now, generation],
      {
        kind: "terminal",
        restartHandoff,
        ...runtimeUsageOption(usage),
      },
    );
  }

  compactRuntimeTerminal(
    ...parameters: readonly [
      ...RuntimeCompactionParameters,
      restartHandoff: RestartHandoff | null,
    ]
  ): void {
    compactRuntime(this.#runtimeResources(), parameters);
  }

  compactRuntimeConversation(...parameters: RuntimeCompactionParameters): void {
    compactRuntime(this.#runtimeResources(), parameters);
  }

  updateRuntimeUsage(
    sessionId: string,
    input: AgentSessionUsageUpdate,
    now: number,
    generation: number,
  ): void {
    updateRuntimeUsage({
      ...runtimeTarget(this.#runtimeResources(), sessionId, now, generation),
      input,
    });
  }

  appendRuntimeAgentMessages(
    ...parameters: RuntimeAppendMessageParameters
  ): void {
    const [sessionId, messages, now, generation, usage] = parameters;
    const writeOptions: RuntimeMessageWriteOptions = {
      kind: "append",
      ...runtimeUsageOption(usage),
    };
    writeAgentMessages(
      this.#runtimeResources(),
      [sessionId, messages, now, generation],
      writeOptions,
    );
  }

  settleRuntimeFailure(...p: [string, string, number, number]): boolean {
    return settleRuntimeFailure({
      content: p[1],
      ...this.#target(p[0], p[2], p[3]),
    });
  }

  appendRuntimeErrorMessage(
    sessionId: string,
    content: string,
    now: number,
    generation: number,
  ): void {
    appendRuntimeErrorMessage({
      content,
      ...this.#target(sessionId, now, generation),
    });
  }
}
