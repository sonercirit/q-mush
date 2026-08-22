import { describe, expect, test } from "vitest";
import type { AgentModel, AgentModelStep } from "../../shared/agent-loop.ts";
import { balancedCredentialId } from "../../shared/provider-credential-pool.ts";
import { testAgentModelCatalog } from "../../shared/test/agent-model-fixtures.ts";
import { AgentModelDiscoveryError } from "../agent-model-discovery-fetch.ts";
import {
  createTestProviderCredential,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  childSessionId,
  completeChildAgentFile,
  failedSpawnOutput,
  spawnCall,
} from "./session-agent-spawn-helpers.ts";
import { startToolSession } from "./session-agent-tool-setup.ts";
import {
  CREDENTIAL_ID,
  SESSION_ID,
  testCredentialId,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

const SECOND_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000095";

function balancedCredentials() {
  const primary = createTestProviderCredential(CREDENTIAL_ID);
  const secondary = createTestProviderCredential(SECOND_CREDENTIAL_ID);
  return { openai: [primary, secondary] };
}

class BalancedSpawnModel implements AgentModel {
  #step = 0;

  complete(): Promise<AgentModelStep> {
    this.#step += 1;
    return Promise.resolve(
      this.#step === 1
        ? providerStep("Delegating balanced work.", {
            toolCalls: [
              spawnCall(
                "Use the balanced model pool",
                undefined,
                [],
                balancedCredentialId("openai"),
              ),
            ],
          })
        : providerStep("Done."),
    );
  }
}

describe("balanced session agent spawn", () => {
  test("spawns a balanced child through the real launch path", async () => {
    const selectedCredentials: string[] = [];
    const model = new BalancedSpawnModel();
    const setup = await startToolSession(
      model,
      {
        credentials: balancedCredentials(),
        modelFactory: ({ credential }) => ({
          complete: () => {
            selectedCredentials.push(testCredentialId(credential));
            return model.complete();
          },
        }),
      },
      (_provider, credential) => {
        if (credential.id === CREDENTIAL_ID) {
          throw new AgentModelDiscoveryError("rejected", 429);
        }
        return Promise.resolve(testAgentModelCatalog());
      },
    );
    const childId = await childSessionId(setup);
    expect(setup.sessions.detailForUser(TEST_USER_ID, childId)).toMatchObject({
      credentialId: SECOND_CREDENTIAL_ID,
      parentSessionId: SESSION_ID,
      status: "running",
    });
    completeChildAgentFile(setup);
    await waitForSessionValue(
      () => selectedCredentials.includes(SECOND_CREDENTIAL_ID),
      Boolean,
    );
    expect(selectedCredentials).toEqual([
      CREDENTIAL_ID,
      CREDENTIAL_ID,
      SECOND_CREDENTIAL_ID,
    ]);
    closeSessionTestDatabase(setup.database);
  });

  test("persists one failed linked child when every balanced credential rejects", async () => {
    const setup = await startToolSession(
      new BalancedSpawnModel(),
      { credentials: balancedCredentials() },
      () => {
        throw new AgentModelDiscoveryError("rejected", 429);
      },
    );

    const output = await failedSpawnOutput(setup);
    const children = setup.sessions
      .listForUser(TEST_USER_ID)
      .filter(({ id }) => id !== SESSION_ID);

    expect(output).toContain('"status": "failed"');
    expect(output).toContain('"error": "credential_unavailable"');
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      parentExecutionGeneration: 0,
      parentSessionId: SESSION_ID,
      status: "failed",
    });
    closeSessionTestDatabase(setup.database);
  });
});
