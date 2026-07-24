import type { AgentReasoningEffort } from "../shared/agent-configuration.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { RunnerExecutionEnvironment } from "../shared/runner-command-broker.ts";

export interface SpawnSessionToolInput {
  readonly credentialId: string;
  readonly executionEnvironment: RunnerExecutionEnvironment;
  readonly images: readonly AgentImage[];
  readonly model: string;
  readonly prompt: string;
  readonly provider: "openai" | "openrouter";
  readonly reasoningEffort: AgentReasoningEffort | null;
  readonly runnerId: string;
  readonly tools: readonly AgentSessionToolName[];
  readonly workingDirectory: string;
}
