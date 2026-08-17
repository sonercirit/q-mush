import type { AgentModelFactory } from "./session-agent-models.ts";
import type { SessionCredentialRead } from "./session-credential-access.ts";
import type { SessionModelContextOptions } from "./session-model-context-options.ts";

export interface RuntimeSessionAgentModelOptions extends SessionModelContextOptions {
  readonly factory: AgentModelFactory;
  readonly markStepStart: () => void;
  readonly readCredential: SessionCredentialRead | undefined;
}
