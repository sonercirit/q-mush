import { expect, test } from "vitest";
import {
  readAgentModelCatalog,
  readSessionDetail,
} from "../../solid/session-codec.ts";
import {
  TEST_AGENT_IMAGE,
  testUserImageMessage,
} from "./agent-image-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const DETAIL = {
  ...TEST_SESSION_DETAIL,
  agentFile: { content: "Project instructions", name: "CLAUDE.md" },
};

test("reads message image metadata from the server", () => {
  const detail = {
    ...DETAIL,
    messages: [testUserImageMessage("message-1", "Review this screenshot")],
  };

  expect(readSessionDetail(detail).messages[0]?.images).toEqual([
    TEST_AGENT_IMAGE,
  ]);
  expect(() =>
    readSessionDetail({
      ...detail,
      messages: [
        { ...detail.messages[0], images: [{ ...TEST_AGENT_IMAGE, data: "!" }] },
      ],
    }),
  ).toThrow("invalid session message");
});

test("reads a session agent file from the server", () => {
  expect(readSessionDetail(DETAIL).agentFile).toEqual({
    content: "Project instructions",
    name: "CLAUDE.md",
  });
  expect(() =>
    readSessionDetail({
      ...DETAIL,
      agentFile: { content: "Ignored", name: "OTHER.md" },
    }),
  ).toThrow("invalid agent file");
});

function modelCatalogValue(
  inputModalities: unknown,
  includeInput = true,
): Readonly<Record<string, unknown>> {
  return {
    defaultModel: "gpt-test",
    models: [
      {
        contextWindow: 128_000,
        id: "gpt-test",
        ...(includeInput ? { inputModalities } : {}),
        label: "GPT Test",
        outputModalities: ["text"],
        pricing: null,
        reasoningEfforts: [],
      },
    ],
  };
}

test("requires explicit context and modality metadata from model responses", () => {
  expect(() => readAgentModelCatalog(modelCatalogValue(null, false))).toThrow(
    "invalid agent model",
  );
  expect(() => readAgentModelCatalog(modelCatalogValue(["text", 1]))).toThrow(
    "invalid model modalities",
  );
});

test("requires explicit context, cost, and compaction metadata from session responses", () => {
  for (const invalid of [
    { ...DETAIL, autoCompact: undefined },
    { ...DETAIL, costBasis: undefined },
    { ...DETAIL, costBasis: "none", costUsd: 1 },
    { ...DETAIL, maxContextTokens: undefined },
  ]) {
    expect(() => readSessionDetail(invalid)).toThrow("invalid agent session");
  }
  expect(() =>
    readAgentModelCatalog({
      defaultModel: "gpt-test",
      models: [
        {
          id: "gpt-test",
          label: "GPT Test",
          reasoningEfforts: [],
        },
      ],
    }),
  ).toThrow("invalid agent model");
});
