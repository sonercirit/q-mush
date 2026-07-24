import { expect } from "vitest";
import { agentSessions } from "../../shared/database/schema.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { connectedSessionSetup } from "./session-integration-fixtures.ts";
import { sessionDetail } from "./session-integration-helpers.ts";
import {
  createIdleStoredSession,
  removeAssignedRunner,
} from "./session-reassignment-test-helpers.ts";

export type RaceSessionSetup = ReturnType<typeof connectedSessionSetup>;

export interface CredentialRace {
  readonly release: () => void;
  readonly setup: RaceSessionSetup;
  readonly waitUntilRead: () => Promise<undefined>;
}

function deferred(): PromiseWithResolvers<undefined> {
  return Promise.withResolvers<undefined>();
}

export function credentialRaceSetup(idleSession = true): CredentialRace {
  const gate = deferred();
  const read = deferred();
  const setup = connectedSessionSetup(
    new ScriptedAgentModel([{ content: "unused", toolCalls: [] }]),
    "api_key",
    undefined,
    {
      credentialGate: gate.promise,
      onCredentialRead: () => {
        read.resolve(undefined);
      },
    },
  );
  if (idleSession) {
    createIdleStoredSession(setup);
  }
  return {
    release: () => {
      gate.resolve(undefined);
    },
    setup,
    waitUntilRead: () => read.promise,
  };
}

export async function finishRemovalRace(
  race: CredentialRace,
  request: Promise<Response>,
): Promise<Response> {
  await race.waitUntilRead();
  expect((await removeAssignedRunner(race.setup)).status).toBe(204);
  race.release();
  return request;
}

export async function expectRaceRejection(
  setup: RaceSessionSetup,
  response: Response,
  error: "runner_required" | "runner_unavailable",
): Promise<void> {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error });
  expect(setup.runnerCommands).toEqual([]);
}

export function closeRaceSetup(setup: RaceSessionSetup): void {
  setup.database.$client.close();
}

async function expectRunnerRequiredIdle(
  setup: RaceSessionSetup,
): Promise<void> {
  const detail = await sessionDetail(setup.sessions);
  expect(detail).toMatchObject({ runnerRequired: true, status: "idle" });
}

export async function rejectRaceAndClose(
  race: CredentialRace,
  response: Response,
  error: "runner_required" | "runner_unavailable",
): Promise<void> {
  await expectRaceRejection(race.setup, response, error);
  if (error === "runner_required") {
    await expectRunnerRequiredIdle(race.setup);
  }
  closeRaceSetup(race.setup);
}

export function expectNoStoredSessions(setup: RaceSessionSetup): void {
  expect(setup.sessions.listForUser(TEST_USER_ID)).toEqual([]);
  expect(
    setup.database.select({ id: agentSessions.id }).from(agentSessions).all(),
  ).toEqual([]);
}
