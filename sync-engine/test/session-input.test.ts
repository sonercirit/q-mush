import { expect, test } from "vitest";
import { readPrompt } from "../../sync-engine/session-input.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";

test("accepts an image-only user message", () => {
  expect(readPrompt({ images: [TEST_AGENT_IMAGE], prompt: "" })).toEqual({
    images: [TEST_AGENT_IMAGE],
    prompt: "",
  });
  expect(readPrompt({ images: [], prompt: "" })).toBeUndefined();
});
