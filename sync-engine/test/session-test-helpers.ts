import { expect } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

export async function expectSessionReaches(
  setup: Awaited<ReturnType<typeof connectedSessionSetup>>,
  response: Response,
  status: string,
) {
  expect(response.status).toBe(201);
  await completeAgentFileLookup(setup);
  await waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus(status),
  );
  return sessionDetail(setup.sessions);
}

export async function startSessionWithAgentFile(
  model: AgentModel,
  agentFile: unknown,
): Promise<Awaited<ReturnType<typeof connectedSessionSetup>>> {
  const setup = connectedSessionSetup(model);
  const createResponse = await setup.sessions.collection(
    createSessionRequest(),
  );

  expect(createResponse.status).toBe(201);
  await completeAgentFileLookup(setup, agentFile);
  await waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus("idle"),
  );
  return setup;
}
