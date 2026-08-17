import { describe, expect, test } from "vitest";
import {
  TEST_SESSION_DETAIL,
  testSessionMessage,
} from "../../shared/test/session-fixtures.ts";
import {
  DEFAULT_READ_SESSION_CATEGORIES,
  readSessionOutput,
} from "../session-agent-read.ts";
import {
  jsonRecord,
  records,
  testRecord,
} from "./session-agent-output-helpers.ts";

describe("read_session output", () => {
  test("uses record count as pagination without an independent byte cap", () => {
    const output = jsonRecord(
      readSessionOutput({
        input: {
          categories: DEFAULT_READ_SESSION_CATEGORIES,
          limit: 1,
          sessionId: TEST_SESSION_DETAIL.id,
        },
        messages: [
          testSessionMessage("one", "a".repeat(40_000), "user", 1),
          testSessionMessage("two", "😀".repeat(30_000), "assistant", 1),
        ],
        session: {
          id: TEST_SESSION_DETAIL.id,
          status: "idle",
          title: "Session",
        },
        systemPrompt: "system",
        toolDefinitions: [],
      }),
    );
    const metadata = testRecord(output["metadata"]);
    const content = testRecord(output["content"]);
    expect(metadata["truncated"]).toBe(true);
    expect(metadata["truncation"]).toEqual({ limit: true });
    expect(records(content["records"])).toMatchObject([
      { content: "😀".repeat(30_000), id: "two" },
    ]);
  });

  test("returns complete selected system and tool-definition sections", () => {
    const prompt = "System 😀".repeat(5_000);
    const definitions = [
      { description: "d".repeat(20_000), name: "read", parameters: {} },
    ];
    const output = jsonRecord(
      readSessionOutput({
        input: {
          categories: ["system", "tools"],
          limit: 20,
          sessionId: "session",
        },
        messages: [],
        session: { id: "session", status: "idle", title: "Session" },
        systemPrompt: prompt,
        toolDefinitions: definitions,
      }),
    );
    const content = testRecord(output["content"]);
    const metadata = testRecord(output["metadata"]);
    expect(content["systemPrompt"]).toBe(prompt);
    expect(content["toolDefinitions"]).toEqual(definitions);
    expect(metadata["truncated"]).toBe(false);
  });

  test("includes assistant tool calls and tool identities", () => {
    const assistant = {
      ...testSessionMessage("assistant", "calling", "assistant", 1),
      toolCalls: [{ arguments: '{"path":"x"}', id: "call", name: "read" }],
    };
    const tool = {
      ...testSessionMessage("tool", "result", "tool", 1),
      toolCallId: "call",
      toolName: "read",
    };
    const output = jsonRecord(
      readSessionOutput({
        input: { categories: ["assistant", "tool"], limit: 20, sessionId: "s" },
        messages: [assistant, tool],
        session: { id: "s", status: "idle", title: "Session" },
        systemPrompt: "",
        toolDefinitions: [],
      }),
    );
    const content = testRecord(output["content"]);
    expect(records(content["records"])).toMatchObject([
      { toolCalls: [{ id: "call", name: "read" }] },
      { toolCallId: "call", toolName: "read" },
    ]);
  });
});
