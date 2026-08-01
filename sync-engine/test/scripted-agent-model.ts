import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";

type ScriptedStep = Omit<
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

export class ScriptedAgentModel implements AgentModel {
  readonly requests: AgentConversationMessage[][] = [];
  readonly #onComplete:
    ((requestCount: number) => Promise<void> | void) | undefined;
  readonly #steps: AgentModelStep[];

  constructor(steps: ScriptedStep[], options: ScriptedModelOptions = {}) {
    this.#onComplete = options.onComplete;
    this.#steps = steps.map((step) => ({
      ...step,
      contextTokens:
        step.contextTokens === undefined ? null : step.contextTokens,
      costUsd: step.costUsd ?? null,
      thinking: step.thinking ?? "",
      tokenUsage: step.tokenUsage ?? null,
    }));
  }

  async complete(
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    const { requestCount } = recordAgentModelRequest(this.requests, messages);
    await this.#onComplete?.(requestCount);
    const step = this.#steps.shift();

    if (step === undefined) {
      throw new Error("The scripted model ran out of steps");
    }

    return step;
  }
}
