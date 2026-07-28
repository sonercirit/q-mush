import type { GoogleAuth } from "./auth.ts";
import type { RunnerIntegration } from "./runners.ts";
import type { SessionCredentialReaders } from "./session-credential-access.ts";
import type { SessionDependencies } from "./session-dependencies.ts";
import type { SessionIntegration } from "./session-integration.ts";

export type SessionIntegrationFactory = (
  auth: GoogleAuth,
  runners: RunnerIntegration,
  providers: SessionCredentialReaders,
  dependencies: SessionDependencies,
) => SessionIntegration;
