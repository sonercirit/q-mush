import { expect, test } from "bun:test";
import { readAgentModelCatalog, readSessionDetail } from "../session-codec.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const DETAIL = {
  ...TEST_SESSION_DETAIL,
  agentFile: { content: "Project instructions", name: "CLAUDE.md" },
};

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

test("requires explicit context and compaction metadata from session responses", () => {
  expect(() =>
    readSessionDetail({ ...DETAIL, autoCompact: undefined }),
  ).toThrow("invalid agent session");
  expect(() =>
    readSessionDetail({ ...DETAIL, maxContextTokens: undefined }),
  ).toThrow("invalid agent session");
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
