import {
  readAgentAttachments,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type {
  RunnerCommandOutputDelta,
  RunnerCommandResult,
} from "../shared/runner-command-broker.ts";
import { estimateAgentStepCost } from "./agent-cost.ts";
import type { AgentSkillExecutor } from "./agent-skills.ts";
import { explainAttachment } from "./attachment-fallback-model.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import { currentExecutionTools } from "./session-agent-tool-authority.ts";
import { agentStepUsage } from "./session-compaction-usage.ts";
import { discoverCurrentSessionModel } from "./session-current-model.ts";
import {
  recordSessionRuntimeUsage,
  type SessionRuntimeWriter,
} from "./session-runtime-write.ts";
import type { ToolStreamPublisher } from "./tool-stream-publisher.ts";

export type AgentToolDispatcher = (
  ...parameters: Parameters<AgentSkillExecutor>
) => Promise<RunnerCommandResult>;

function currentToolNames(
  runtime: SessionAgentRuntimeDependencies,
): readonly AgentSessionToolName[] | undefined {
  return currentExecutionTools({
    current: runtime.currentTools?.(),
    isCurrent: runtime.isCurrent,
    persisted: runtime.detail.tools,
  });
}

async function explainFileResult(
  runtime: SessionAgentRuntimeDependencies,
  writeRuntime: SessionRuntimeWriter,
  toolArguments: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  output: string,
): Promise<string> {
  const promptValue = toolArguments["prompt"];
  if (
    promptValue !== undefined &&
    (typeof promptValue !== "string" || promptValue.length > 4_000)
  ) {
    throw new Error(
      "Tool argument prompt must be a string of at most 4000 characters",
    );
  }
  let attachment: AgentAttachment | undefined;
  try {
    attachment = readAgentAttachments([JSON.parse(output)])?.[0];
  } catch {
    attachment = undefined;
  }
  if (attachment === undefined) {
    throw new Error("The runner returned invalid file attachment data");
  }
  const currentModel = await discoverCurrentSessionModel(runtime, signal);
  if (currentModel === undefined) {
    throw new Error("The session model is unavailable for file explanation");
  }
  const explanation = await explainAttachment(
    {
      attachment,
      currentCredential: runtime.credential,
      currentModel,
      currentModelId: runtime.detail.model,
      currentProvider: runtime.detail.provider,
      currentProviderPricing: runtime.detail.providerPricing,
      currentProviderTag: runtime.detail.openRouterProviderTag,
      factory: runtime.modelFactory,
      onStepStart: () => {
        const { store } = runtime;
        writeRuntime(store.markRuntimeStepStart.bind(store));
      },
      prompt: typeof promptValue === "string" ? promptValue : null,
      resources: runtime,
      userId: runtime.userId,
      workspaceId: runtime.detail.workspaceId,
    },
    signal,
  );
  const usage = agentStepUsage(
    { contextTokens: null, ...explanation.usage },
    (step) =>
      estimateAgentStepCost(
        { providerPricing: explanation.providerPricing },
        step.tokenUsage,
      ),
  );
  if (usage !== undefined) {
    recordSessionRuntimeUsage(runtime, usage);
  }
  return explanation.content;
}

export function createRunnerToolDispatcher(options: {
  readonly executeForSession: (
    execute: () => Promise<RunnerCommandResult>,
    handoff: (error: DOMException) => void,
  ) => Promise<RunnerCommandResult>;
  readonly handoffController: AbortController;
  readonly runtime: SessionAgentRuntimeDependencies;
  readonly toolSignal: AbortSignal;
  readonly toolStream: ToolStreamPublisher;
  readonly writeRuntime: SessionRuntimeWriter;
}): {
  readonly currentToolNames: () => readonly AgentSessionToolName[] | undefined;
  readonly dispatchRunnerTool: AgentToolDispatcher;
} {
  const { runtime } = options;
  const names = () => currentToolNames(runtime);
  const dispatchRunnerTool: AgentToolDispatcher = async (
    name,
    toolArguments,
    signal = options.toolSignal,
    callId,
  ) => {
    const result = await options.executeForSession(
      () =>
        runtime.broker.dispatch(
          {
            arguments: toolArguments,
            authorize: () =>
              names()?.some((candidate) => candidate === name) === true,
            executionEnvironment: runtime.detail.executionEnvironment,
            generation: runtime.detail.generation,
            runnerId: runtime.detail.runnerId,
            sessionId: runtime.detail.id,
            tool: name,
            workingDirectory: runtime.detail.workingDirectory,
          },
          signal,
          callId === undefined
            ? undefined
            : (delta: RunnerCommandOutputDelta) => {
                options.toolStream.output(callId, delta);
              },
        ),
      (error) => {
        options.handoffController.abort(error);
      },
    );
    if (name !== "explain_file" || result.state !== "completed") {
      return result;
    }
    return {
      output: await explainFileResult(
        runtime,
        options.writeRuntime,
        toolArguments,
        signal,
        result.output,
      ),
      state: "completed",
    };
  };
  return { currentToolNames: names, dispatchRunnerTool };
}
