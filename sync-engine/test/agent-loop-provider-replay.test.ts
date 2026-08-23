import { expect, test } from "vitest";
import {
  runAgentLoop,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import {
  TEST_PROVIDER_REPLAY,
  TEST_PROVIDER_REPLAY_ASSISTANT,
  TEST_READ_CALL,
} from "./provider-replay-fixtures.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

test("carries provider replay through a tool turn", async () => {
  const recorded: AgentRecordedMessage[] = [];
  const model = new ScriptedAgentModel([
    {
      ...TEST_PROVIDER_REPLAY_ASSISTANT,
      thinking: "I should read the project documentation first.",
    },
    { content: "The project is ready.", toolCalls: [] },
  ]);

  await runAgentLoop({
    executeTool: () => Promise.resolve("# Q Mush"),
    initialMessages: [{ content: "Inspect this project", role: "user" }],
    recordMessage: (messages) => {
      recorded.splice(recorded.length, 0, ...messages);
    },
    model,
  });

  const expected = TEST_PROVIDER_REPLAY_ASSISTANT;
  expect(recorded).toContainEqual(expected);
  expect(model.requests[1]).toContainEqual(expected);
  expect(expected.providerReplay).toBe(TEST_PROVIDER_REPLAY);
  expect(expected.toolCalls).toEqual([TEST_READ_CALL]);
});
