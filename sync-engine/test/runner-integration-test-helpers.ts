import { expect } from "vitest";
import type { AppDatabase } from "../../shared/database.ts";
import { RUNNER_REALTIME_PATH } from "../../shared/routes.ts";
import { createGoogleAuthFromEnvironment } from "../../sync-engine/auth.ts";
import {
  createRunnerIntegration,
  type RunnerIntegration,
} from "../../sync-engine/runners.ts";
import {
  createRunnerRequest,
  TEST_NOW,
} from "./authenticated-integration-test-helpers.ts";
import { takeValue } from "./oauth-test-helpers.ts";

export interface RunnerIntegrationTestSetup {
  readonly database: AppDatabase;
  readonly integration: RunnerIntegration;
}

type RunnerIntegrationDependencies = NonNullable<
  Parameters<typeof createRunnerIntegration>[1]
>;

export function closeRunnerIntegrationTestSetup(
  setup: RunnerIntegrationTestSetup,
): void {
  setup.database.$client.close();
}

export function createTestRunnerIntegration(
  database: AppDatabase,
  dependencies: Omit<RunnerIntegrationDependencies, "database"> = {},
): RunnerIntegration {
  return createRunnerIntegration(
    createGoogleAuthFromEnvironment({}, { database, now: () => TEST_NOW }),
    { database, now: () => TEST_NOW, ...dependencies },
  );
}

function queuedValue<T>(values: T[], description: string): () => T {
  return () => takeValue(values, `The test ran out of ${description}`);
}

export function createQueuedTestRunnerIntegration(
  database: AppDatabase,
  ids: string[],
  tokens: string[],
  dependencies: Omit<
    RunnerIntegrationDependencies,
    "database" | "randomId" | "randomToken"
  > = {},
): RunnerIntegration {
  return createTestRunnerIntegration(database, {
    ...dependencies,
    randomId: queuedValue(ids, "runner IDs"),
    randomToken: queuedValue(tokens, "runner tokens"),
  });
}

export function runnerMetadata(
  machineFingerprint: string,
  name = "workstation",
) {
  return {
    architecture: "x64",
    machineFingerprint,
    name,
    platform: "linux",
  };
}

export function expectRunnerToken(
  integration: RunnerIntegration,
  token: string,
  expected: string | undefined,
): void {
  expect(runnerToken(integration, token)).toBe(expected);
}

function runnerToken(
  integration: RunnerIntegration,
  token: string,
): string | undefined {
  return integration.runnerToken(
    createRunnerRequest(RUNNER_REALTIME_PATH, token),
  );
}
