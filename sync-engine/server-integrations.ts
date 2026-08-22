import type { GoogleAuth } from "./auth.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import type { GenericProviderIntegration } from "./generic-provider.ts";
import type { OpenAiIntegration } from "./openai.ts";
import type { OpenRouterIntegration } from "./openrouter.ts";
import type { PromptIntegration } from "./prompts.ts";
import type { RunnerExecutableProvider } from "./runner-executable.ts";
import type { RunnerIntegration } from "./runners.ts";
import type { SessionIntegration } from "./sessions.ts";
import type { ToolSettingsIntegration } from "./tool-settings.ts";
import type { WorkspaceIntegration } from "./workspaces.ts";

export interface RequestHandlerIntegrations {
  readonly braveSearch: BraveSearchSkill;
  readonly googleAuth: GoogleAuth;
  readonly openAi: OpenAiIntegration;
  readonly openRouter: OpenRouterIntegration;
  readonly prompts: PromptIntegration;
  readonly runnerExecutables: RunnerExecutableProvider;
  readonly runners: RunnerIntegration;
  readonly sessions: SessionIntegration;
  readonly toolSettings: ToolSettingsIntegration;
  readonly workspaces: WorkspaceIntegration;
  readonly generic?: GenericProviderIntegration;
}
