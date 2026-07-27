import { expect, test } from "vitest";
import { readPrompt, readPromptList } from "../../solid/prompt-codec.ts";
import { TEST_PROMPT } from "./prompt-fixtures.ts";

test("reads prompt collection and item payloads", () => {
  expect(readPrompt(TEST_PROMPT)).toEqual(TEST_PROMPT);
  expect(readPromptList({ prompts: [TEST_PROMPT] })).toEqual([TEST_PROMPT]);
});

test("rejects malformed prompt payloads", () => {
  for (const value of [
    null,
    { ...TEST_PROMPT, body: undefined },
    { ...TEST_PROMPT, createdAt: Number.NaN },
    { ...TEST_PROMPT, id: undefined },
    { ...TEST_PROMPT, name: undefined },
    { ...TEST_PROMPT, revision: 0 },
    { ...TEST_PROMPT, updatedAt: "now" },
  ]) {
    expect(() => readPrompt(value)).toThrow("invalid prompt");
  }
  expect(() => readPromptList({ prompts: [TEST_PROMPT, null] })).toThrow(
    "invalid prompt",
  );
  expect(() => readPromptList([])).toThrow("invalid prompt list");
  expect(() =>
    readPromptList({
      prompts: Array.from({ length: 101 }, () => TEST_PROMPT),
    }),
  ).toThrow("invalid prompt list");
});
