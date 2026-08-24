import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";

export type ScriptedStep = Omit<
  AgentModelStep,
  "contextTokens" | "costUsd" | "thinking" | "tokenUsage"
> & {
  readonly contextTokens?: number | null;
  readonly costUsd?: number | null;
  readonly thinking?: string;
  readonly tokenUsage?: AgentModelStep["tokenUsage"];
};

interface ScriptedModelOptions {
  readonly onComplete?: (requestCount: number) => Promise<void> | void;
}

export function recordAgentModelRequest<T>(
  requests: T[][],
  messages: readonly T[],
): AgentModelRequest<T> {
  const request = [...messages];
  requests.push(request);
  return { request, requestCount: requests.length };
}

interface AgentModelRequest<T> {
  readonly request: T[];
  readonly requestCount: number;
}

export interface ScriptedAgentModel extends AgentModel {
  readonly requests: AgentConversationMessage[][];
  stepStarts: number;
}

export function createScriptedAgentModel(
  steps: ScriptedStep[],
  options: ScriptedModelOptions = {},
): ScriptedAgentModel {
  const requests: AgentConversationMessage[][] = [];
  const pendingSteps: AgentModelStep[] = steps.map((step) => ({
    ...step,
    contextTokens: step.contextTokens === undefined ? null : step.contextTokens,
    costUsd: step.costUsd ?? null,
    thinking: step.thinking ?? "",
    tokenUsage: step.tokenUsage ?? null,
  }));
  let stepStarts = 0;
  return {
    async complete(messages): Promise<AgentModelStep> {
      const { requestCount } = recordAgentModelRequest(requests, messages);
      await options.onComplete?.(requestCount);
      const step = pendingSteps.shift();
      if (step === undefined) throw new Error("The scripted model ran out of steps");
      return step;
    },
    requests,
    startStep(): void { stepStarts += 1; },
    get stepStarts(): number { return stepStarts; },
    set stepStarts(value: number) { stepStarts = value; },
  };
}
