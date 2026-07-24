import { expect, test } from "vitest";
import type { AgentModel, AgentModelTurn } from "../../shared/agent-loop.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

class BlockingCompactionModel implements AgentModel {
  readonly #initial: AgentModelTurn;
  releaseCompaction: ((turn: AgentModelTurn) => void) | undefined;
  requests = 0;

  constructor(initial: AgentModelTurn) {
    this.#initial = initial;
  }

  complete(): Promise<AgentModelTurn> {
    this.requests += 1;
    if (this.requests === 1) {
      return Promise.resolve(this.#initial);
    }
    return new Promise((resolve) => {
      this.releaseCompaction = resolve;
    });
  }
}

test("hands off after a restart requested during manual compaction", async () => {
  const turn: AgentModelTurn = {
    content: "Initial compaction source.",
    contextTokens: 90_000,
    costUsd: null,
    thinking: "",
    tokenUsage: null,
    toolCalls: new Array<never>(),
  };
  const model = new BlockingCompactionModel(turn);
  const setup = connectedSessionSetup(model, "api_key", undefined, {
    restartId: () => "compaction-restart",
  });
  const created = await setup.sessions.collection(createSessionRequest());
  expect(created.status).toBe(201);
  await completeAgentFileLookup(setup);
  await waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus("idle"),
  );

  const compactResponse = await setup.sessions.compact(
    createAuthenticatedRequest(
      `${SESSIONS_PATH}/${SESSION_ID}/compact`,
      undefined,
      "POST",
    ),
    SESSION_ID,
  );
  expect(compactResponse.status).toBe(202);
  await completeAgentFileLookup(setup);
  await waitForSessionValue(
    () => model.releaseCompaction,
    (value) => typeof value === "function",
  );
  const draining = setup.sessions.drain();
  model.releaseCompaction?.({
    ...turn,
    content: "Compacted before restart.",
  });
  await draining;

  const detail = await sessionDetail(setup.sessions);
  expect(JSON.stringify(detail)).toContain("Compacted before restart.");
  expect(detail).toMatchObject({
    restartHandoff: {
      requestedBy: "server",
      restartId: "compaction-restart",
    },
    status: "paused",
  });
  setup.database.$client.close();
});
