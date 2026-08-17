import type { AgentModel } from "../shared/agent-loop.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type {
  AgentCredentialRefresher,
  AgentModelRequestOptions,
} from "./agent-model-options.ts";
import type { SessionModelContextOptions } from "./session-model-context-options.ts";

export interface SessionAgentModelCreationOptions extends SessionModelContextOptions {
  readonly factory: (
    options: AgentModelRequestOptions & {
      readonly providerPricing: AgentSessionDetail["providerPricing"];
      readonly systemPrompt: string;
    },
  ) => AgentModel;
  readonly id?: () => string;
  readonly onStepStart?: () => void;
  readonly refreshCredential?: AgentCredentialRefresher;
}
