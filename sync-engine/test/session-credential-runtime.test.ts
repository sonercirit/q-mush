import { describe, expect, test } from "vitest";
import type { AgentModel, AgentModelTurn } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import { SessionCredentialReassignmentStore } from "../../sync-engine/session-credential-reassignment-store.ts";
import {
  createAuthenticatedRequest,
  TEST_NOW,
} from "./authenticated-integration-test-helpers.ts";
import { doneTurn } from "./provider-turn-fixtures.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  CREDENTIAL_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

const TARGET_CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000099";

class DeferredModel implements AgentModel {
  readonly credentials: string[] = [];
  #complete: ((turn: AgentModelTurn) => void) | undefined;

  complete(): Promise<AgentModelTurn> {
    return new Promise((resolve) => {
      this.#complete = resolve;
    });
  }

  finish(content: string): void {
    const complete = this.#complete;
    if (complete === undefined) {
      throw new Error("The model turn has not started");
    }
    this.#complete = undefined;
    complete(doneTurn(content));
  }
}

async function continueSession(
  sessions: Parameters<typeof sessionDetail>[0],
): Promise<Response> {
  const continuationPath = [SESSIONS_PATH, SESSION_ID, "continue"].join("/");
  return sessions.continue(
    createAuthenticatedRequest(continuationPath, undefined, "POST"),
    SESSION_ID,
  );
}

async function waitForIdleSession(
  sessions: Parameters<typeof sessionDetail>[0],
): Promise<void> {
  await waitForSessionValue(
    () => sessionDetail(sessions),
    (value) => isRecord(value) && value["status"] === "idle",
  );
}

async function waitForCredentialSelections(
  selectedCredentials: readonly string[],
  count: number,
): Promise<void> {
  await waitForSessionValue(
    () => selectedCredentials.length,
    (value) => value === count,
  );
}

describe("session credential reassignment runtime boundary", () => {
  test("keeps an in-flight credential stable and resolves the persisted target next turn", async () => {
    const model = new DeferredModel();
    const selectedCredentials: string[] = [];
    const setup = connectedSessionSetup(model, "api_key", undefined, {
      credentials: {
        [CREDENTIAL_ID]: "source-secret",
        [TARGET_CREDENTIAL_ID]: "target-secret",
      },
      onCredentialSelected: (secret) => {
        selectedCredentials.push(secret);
      },
    });
    const { database, sessions } = setup;
    await sessions.collection(createSessionRequest());
    await completeAgentFileLookup(setup);
    await waitForCredentialSelections(selectedCredentials, 1);

    const reassignment = new SessionCredentialReassignmentStore(database);
    expect(
      reassignment.reassign(
        "018bcfe5-6800-7000-8000-000000000021",
        "openai",
        TARGET_CREDENTIAL_ID,
        TEST_NOW + 1,
      ),
    ).toEqual({ migratedSessionCount: 1 });
    expect(selectedCredentials).toEqual(["source-secret"]);

    model.finish("First turn complete");
    await waitForIdleSession(sessions);
    const continuation = await continueSession(sessions);
    expect(continuation.status).toBe(202);
    await completeAgentFileLookup(setup);
    await waitForCredentialSelections(selectedCredentials, 2);

    expect(selectedCredentials).toEqual(["source-secret", "target-secret"]);
    model.finish("Second turn complete");
    await waitForIdleSession(sessions);
    database.$client.close();
  });
});
