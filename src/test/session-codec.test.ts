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

test("requires explicit context metadata from session and model responses", () => {
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
