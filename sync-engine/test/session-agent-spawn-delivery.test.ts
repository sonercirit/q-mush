import { expect, test } from "vitest";
import type { AgentModel, AgentModelTurn } from "../../shared/agent-loop.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import {
  createAuthenticatedRequest,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { providerTurn } from "./provider-turn-fixtures.ts";
import { childSessionId, spawnCall } from "./session-agent-spawn-helpers.ts";
import {
  startToolSession,
  waitForSessionContent,
} from "./session-agent-tool-setup.ts";
import { RUNNER_ID, SESSION_ID } from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

class ParentGenerationDeliveryModel implements AgentModel {
  #requestCount = 0;

  complete(): Promise<AgentModelTurn> {
    this.#requestCount += 1;
    const turn = [
      {
        content: "Delegating before another parent turn.",
        toolCalls: [spawnCall("Complete after the parent advances")],
      },
      { content: "The parent is initially idle.", toolCalls: [] },
      { content: "The parent advanced while the child ran.", toolCalls: [] },
      { content: "The child completed after that advance.", toolCalls: [] },
      {
        content: "The advanced parent received the child report.",
        toolCalls: [],
      },
    ][this.#requestCount - 1];
    if (turn === undefined) {
      throw new Error("The delivery model ran out of turns");
    }
    return Promise.resolve(
      providerTurn(turn.content, { toolCalls: turn.toolCalls }),
    );
  }
}

function completeRunnerCommand(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  command: { readonly id: string },
): void {
  const completed = setup.sessions.completeRunnerCommand(
    RUNNER_ID,
    command.id,
    { output: "null", state: "completed" },
  );
  expect(completed).toBe(true);
}

function isRunnerCommand(value: unknown): value is RunnerToolCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "sessionId" in value &&
    typeof value.sessionId === "string"
  );
}

async function latestCommandFor(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  sessionId: string,
  excludedId?: string,
) {
  const command = await waitForSessionValue(
    () => setup.latestRunnerCommand(),
    (value) =>
      isRunnerCommand(value) &&
      value.sessionId === sessionId &&
      value.id !== excludedId,
  );
  if (!isRunnerCommand(command)) {
    throw new Error("The runner command is unavailable");
  }
  return command;
}

test("delivers and runs an idle parent after its generation advances", async () => {
  let commandSequence = 0;
  const setup = await startToolSession(new ParentGenerationDeliveryModel(), {
    commandId: () =>
      commandSequence++ === 0
        ? "agent-command-1"
        : `spawn-delivery-${String(commandSequence)}`,
  });
  const childId = await childSessionId(setup);
  const childCommand = setup.latestRunnerCommand();
  expect(childCommand?.sessionId).toBe(childId);

  const continueRequest = createAuthenticatedRequest(
    `${SESSIONS_PATH}/${SESSION_ID}/continue`,
    undefined,
    "POST",
  );
  const continued = await setup.sessions.continue(continueRequest, SESSION_ID);
  expect(continued.status).toBe(202);
  const interveningCommand = await latestCommandFor(setup, SESSION_ID);
  completeRunnerCommand(setup, interveningCommand);
  await waitForSessionContent(
    setup,
    "The parent advanced while the child ran.",
  );

  if (childCommand === undefined) {
    throw new Error("The child runner command is unavailable");
  }
  completeRunnerCommand(setup, childCommand);
  const childStatus = hasSessionStatus("idle");
  const completedChild = await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, childId),
    childStatus,
  );
  expect(childStatus(completedChild)).toBe(true);

  const callbackCommand = await latestCommandFor(
    setup,
    SESSION_ID,
    interveningCommand.id,
  );
  completeRunnerCommand(setup, callbackCommand);
  const parent = await waitForSessionContent(
    setup,
    "The advanced parent received the child report.",
  );
  expect(JSON.stringify(parent)).toContain(
    "The child completed after that advance.",
  );
  closeSessionTestDatabase(setup.database);
});
