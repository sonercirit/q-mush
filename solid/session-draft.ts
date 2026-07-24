import type { AgentImage } from "../shared/agent-images.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";

export interface SessionDraft extends Pick<
  AgentSessionSummary,
  "executionEnvironment" | "model" | "runnerId" | "tools" | "workingDirectory"
> {
  readonly credential: string;
  readonly images: readonly AgentImage[];
  readonly prompt: string;
  readonly reasoningEffort: string;
}
