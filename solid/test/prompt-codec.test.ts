import { expect, test } from "vitest";
import { readPrompt, readPromptList } from "../../solid/prompt-codec.ts";

import { TEST_PROMPT } from "./prompt-fixtures.ts";

const PROMPT = {
  ...TEST_PROMPT,
  body: "Inspect the repository before editing.",
  id: "018bcfe5-6800-7000-8000-000000000081",
  name: "Inspect first",
  revision: 1,
};

test("reads prompt collection and item payloads", () => {
  expect(readPrompt(PROMPT)).toEqual(PROMPT);
  expect(readPromptList({ prompts: [PROMPT] })).toEqual([PROMPT]);
});

test("rejects malformed prompt payloads", () => {
  for (const value of [
    null,
    { ...PROMPT, body: undefined },
    { ...PROMPT, createdAt: Number.NaN },
    { ...PROMPT, id: undefined },
    { ...PROMPT, name: undefined },
    { ...PROMPT, revision: 0 },
    { ...PROMPT, updatedAt: "now" },
  ]) {
    expect(() => readPrompt(value)).toThrow("invalid prompt");
  }
  expect(() => readPromptList({ prompts: [PROMPT, null] })).toThrow(
    "invalid prompt",
  );
  expect(() => readPromptList([])).toThrow("invalid prompt list");
  expect(() =>
    readPromptList({ prompts: Array.from({ length: 101 }, () => PROMPT) }),
  ).toThrow("invalid prompt list");
});
