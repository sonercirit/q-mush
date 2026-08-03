import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { executeSessionAgentTool } from "../session-agent-tools.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  completedParentDetail,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import { unusedSessionToolActions } from "./session-agent-tool-test-helpers.ts";
import { SESSION_ID } from "./session-integration-fixtures.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

class SelfCompactingModel implements AgentModel {
  #step = 0;

  complete(
    input: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    void input;
    this.#step += 1;
    const response =
      this.#step === 1
        ? {
            content: "I will compact at this step boundary.",
            toolCalls: [toolCall("compact_session", { sessionId: SESSION_ID })],
          }
        : this.#step === 2
          ? { content: "Self-compaction handoff", toolCalls: [] }
          : { content: "Continued after self-compaction.", toolCalls: [] };
    return Promise.resolve(providerStep(response.content, response));
  }
}

test("rejects invalid compact and steer dispatch arguments", async () => {
  const outputs = await Promise.all([
    executeSessionAgentTool(unusedSessionToolActions(), "compact_session", {
      sessionId: SESSION_ID,
      unexpected: true,
    }),
    executeSessionAgentTool(unusedSessionToolActions(), "steer_session", {
      message: "",
      sessionId: SESSION_ID,
    }),
  ]);

  expect(outputs[0].output).toContain("invalid arguments");
  expect(outputs[1].output).toContain("message is invalid");
});

test("self-compaction schedules at the tool boundary and continues", async () => {
  const setup = await startToolSession(new SelfCompactingModel());
  const detail = await completedParentDetail(setup, "idle");
  const serialized = JSON.stringify(detail);

  expect(serialized).toContain("Self-compaction handoff");
  expect(serialized).toContain("Continued after self-compaction.");
  closeSessionTestDatabase(setup.database);
});
