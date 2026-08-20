import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { AppDatabase } from "../../shared/database.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import {
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
  testAuditFields,
} from "./authenticated-integration-test-helpers.ts";
import { CREDENTIAL_ID, RUNNER_ID } from "./session-integration-fixtures.ts";

export function addSessionListFixtures(options: {
  readonly count: number;
  readonly database: AppDatabase;
  readonly id: (index: number) => string;
  readonly status: (index: number) => "idle" | "running";
  readonly title: (index: number) => string;
  readonly workingDirectory: (index: number) => string;
}): void {
  options.database
    .insert(agentSessions)
    .values(
      Array.from({ length: options.count }, (_, index) => ({
        ...testAuditFields(),
        executionEnvironment: "bare_metal" as const,
        id: options.id(index),
        model: "gpt-4.1-mini",
        provider: "openai" as const,
        providerCredentialId: CREDENTIAL_ID,
        runnerId: RUNNER_ID,
        status: options.status(index),
        title: options.title(index),
        tools: JSON.stringify(AGENT_SESSION_TOOL_NAMES),
        userId: TEST_USER_ID,
        workingDirectory: options.workingDirectory(index),
        workspaceId: TEST_WORKSPACE_ID,
      })),
    )
    .run();
}
