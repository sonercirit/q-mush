import { expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import {
  readCreateSession,
  readPrompt,
  readUserSpawnSession,
} from "../../sync-engine/session-input.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";

const SESSION_INPUT = {
  credentialId: "credential-1",
  executionEnvironment: "bare_metal",
  model: "gpt-4.1-mini",
  prompt: "Inspect the project",
  provider: "openai",
  runnerId: "runner-1",
  tools: ["read"],
  workingDirectory: ".",
  workspaceId: "workspace-1",
};

function expectInvalidTools(
  read: (input: Readonly<Record<string, unknown>>) => unknown,
  input: Readonly<Record<string, unknown>>,
): void {
  for (const tools of [["read", "read"], ["unknown"]]) {
    expect(read({ ...input, tools })).toBeUndefined();
  }
}

test("validates session tool and skill selections", () => {
  const input = { ...SESSION_INPUT, tools: ["read", "brave_search"] };

  expect(readCreateSession(input)?.tools).toEqual(["read", "brave_search"]);
  expect(readCreateSession({ ...input, tools: undefined })?.tools).toEqual(
    AGENT_SESSION_TOOL_NAMES,
  );
  expect(readCreateSession({ ...input, tools: [] })?.tools).toEqual([]);
  expectInvalidTools(readCreateSession, input);
});

test("validates a user-spawned child tool subset and parent identity", () => {
  const input = {
    ...SESSION_INPUT,
    parentGeneration: 3,
    parentSessionId: "parent-session",
    tools: ["read", "brave_search"],
  };

  expect(readUserSpawnSession(input)).toMatchObject({
    parentGeneration: 3,
    parentSessionId: "parent-session",
    tools: ["read", "brave_search"],
  });
  expectInvalidTools(readUserSpawnSession, input);
  expect(readUserSpawnSession({ ...input, tools: undefined })).toBeUndefined();
  expect(
    readUserSpawnSession({ ...input, parentGeneration: -1 }),
  ).toBeUndefined();
});

test("accepts an optional custom agent file path", () => {
  const absoluteAgentFilePath = "/home/user/instructions.md";
  expect(
    readCreateSession({
      ...SESSION_INPUT,
      agentFilePath: absoluteAgentFilePath,
    })?.agentFilePath,
  ).toBe(absoluteAgentFilePath);
  expect(
    readCreateSession({
      ...SESSION_INPUT,
      agentFilePath: "config/instructions.md",
    })?.agentFilePath,
  ).toBe("config/instructions.md");
  expect(
    readCreateSession({ ...SESSION_INPUT, agentFilePath: "  " })?.agentFilePath,
  ).toBeNull();
  for (const agentFilePath of [null, 42, "path\0instructions.md"]) {
    expect(
      readCreateSession({ ...SESSION_INPUT, agentFilePath }),
    ).toBeUndefined();
  }
});

test("accepts OpenRouter routing modes and legacy provider tags", () => {
  const openRouterInput = { ...SESSION_INPUT, provider: "openrouter" };

  expect(
    readCreateSession({
      ...openRouterInput,
      openRouterProviderTag: "q-mush-routing:throughput",
    })?.openRouterProviderTag,
  ).toBe("q-mush-routing:throughput");
  expect(
    readCreateSession({
      ...openRouterInput,
      openRouterProviderTag: "google-vertex/us",
    })?.openRouterProviderTag,
  ).toBe("google-vertex/us");
  expect(
    readCreateSession({
      ...openRouterInput,
      openRouterProviderTag: "q-mush-routing:unknown",
    }),
  ).toBeUndefined();
});

test("defaults auto-compaction on and strictly accepts a boolean override", () => {
  expect(readCreateSession(SESSION_INPUT)?.autoCompact).toBe(true);
  expect(
    readCreateSession({ ...SESSION_INPUT, autoCompact: false })?.autoCompact,
  ).toBe(false);
  for (const autoCompact of ["false", 0, null]) {
    expect(
      readCreateSession({ ...SESSION_INPUT, autoCompact }),
    ).toBeUndefined();
  }
});

test("accepts an image-only user message", () => {
  expect(readPrompt({ images: [TEST_AGENT_IMAGE], prompt: "" })).toEqual({
    images: [TEST_AGENT_IMAGE],
    prompt: "",
  });
  expect(readPrompt({ images: [], prompt: "" })).toBeUndefined();
});
