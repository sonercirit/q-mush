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
  const model = new ScriptedAgentModel([
    {
      ...TEST_PROVIDER_REPLAY_ASSISTANT,
      thinking: "I should read the project documentation first.",
    },
    { content: "The project is ready.", toolCalls: [] },
  ]);
  const recorded: AgentRecordedMessage[] = [];

  const recordMessage = (messages: readonly AgentRecordedMessage[]) => {
    recorded.push(...messages);
  };
  await runAgentLoop({
    executeTool: () => Promise.resolve("# Q Mush"),
    initialMessages: [{ content: "Inspect this project", role: "user" }],
    model,
    recordMessage,
  });

  const expected = TEST_PROVIDER_REPLAY_ASSISTANT;
  expect(recorded).toContainEqual(expected);
  expect(model.requests[1]).toContainEqual(expected);
  expect(expected.providerReplay).toBe(TEST_PROVIDER_REPLAY);
  expect(expected.toolCalls).toEqual([TEST_READ_CALL]);
});
