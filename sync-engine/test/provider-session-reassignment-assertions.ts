import { expect } from "vitest";
import type { ProviderId } from "../../shared/provider-credential-store.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import {
  addProviderSessionFixture,
  readSessionCredential,
  readStoredProviderCredentials,
  reassignProviderSessions,
  setProviderDefaults,
  type ProviderTestRoutes,
  type ProviderTestSetup,
} from "./provider-integration-test-helpers.ts";

function expectStoredDefault(
  stored: readonly { readonly id: string; readonly isDefault: boolean }[],
  defaultCredentialId: string,
  targetCredentialId: string,
): void {
  expect(stored.find(({ id }) => id === defaultCredentialId)?.isDefault).toBe(
    true,
  );
  expect(stored.find(({ id }) => id === targetCredentialId)?.isDefault).toBe(
    false,
  );
}

interface ProviderTestReassignmentSetup {
  readonly setup: ProviderTestSetup;
  readonly routes: ProviderTestRoutes;
}

interface ProviderTestReassignmentExpectation {
  readonly defaultCredentialId: string;
  readonly provider: ProviderId;
  readonly sessionId: string;
  readonly targetCredentialId: string;
}

export async function expectPreparedProviderSessionReassignment(options: {
  readonly input: ProviderTestReassignmentSetup;
  readonly expected: ProviderTestReassignmentExpectation;
  readonly prepare: () => Promise<void>;
}): Promise<void> {
  const { expected, input } = options;
  await options.prepare();
  const { routes, setup } = input;
  expect(
    setProviderDefaults(setup.integration, routes.credentialsPath, [
      expected.defaultCredentialId,
    ]),
  ).toEqual([204]);
  addProviderSessionFixture(setup, {
    otherCredentialId: expected.defaultCredentialId,
    provider: expected.provider,
    sessionId: expected.sessionId,
  });
  await verifyProviderSessionReassignment(setup, routes, expected);
  setup.database.$client.close();
}

async function verifyProviderSessionReassignment(
  setup: ProviderTestSetup,
  routes: ProviderTestRoutes,
  expected: ProviderTestReassignmentExpectation,
): Promise<void> {
  const response = await reassignProviderSessions(
    setup,
    routes,
    expected.targetCredentialId,
  );
  expect(await response.json()).toEqual({ migratedSessionCount: 1 });
  expect(
    readSessionCredential(setup.database, TEST_USER_ID, expected.sessionId),
  ).toBe(expected.targetCredentialId);

  const stored = readStoredProviderCredentials(
    setup.database,
    expected.provider,
  );
  expectStoredDefault(
    stored,
    expected.defaultCredentialId,
    expected.targetCredentialId,
  );
  expect(setup.sessionsChanged).toEqual([TEST_USER_ID]);
}
