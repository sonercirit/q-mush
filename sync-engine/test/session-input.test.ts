import { expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import {
  readCreateSession,
  readPrompt,
} from "../../sync-engine/session-input.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";

test("validates session tool and skill selections", () => {
  const input = {
    credentialId: "credential-1",
    model: "gpt-4.1-mini",
    prompt: "Inspect the project",
    provider: "openai",
    runnerId: "runner-1",
    tools: ["read", "brave_search"],
    workingDirectory: ".",
  };

  expect(readCreateSession(input)?.tools).toEqual(["read", "brave_search"]);
  expect(readCreateSession({ ...input, tools: undefined })?.tools).toEqual(
    AGENT_SESSION_TOOL_NAMES,
  );
  expect(readCreateSession({ ...input, tools: [] })?.tools).toEqual([]);
  expect(
    readCreateSession({ ...input, tools: ["read", "read"] }),
  ).toBeUndefined();
  expect(readCreateSession({ ...input, tools: ["unknown"] })).toBeUndefined();
});

test("accepts an image-only user message", () => {
  expect(readPrompt({ images: [TEST_AGENT_IMAGE], prompt: "" })).toEqual({
    images: [TEST_AGENT_IMAGE],
    prompt: "",
  });
  expect(readPrompt({ images: [], prompt: "" })).toBeUndefined();
});
