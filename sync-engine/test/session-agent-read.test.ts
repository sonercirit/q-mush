import { describe, expect, test } from "vitest";
import {
  TEST_SESSION_DETAIL,
  testSessionMessage,
} from "../../shared/test/session-fixtures.ts";
import { MINIMUM_TOOL_OUTPUT_CHARACTERS } from "../../shared/tool-limits.ts";
import { unicodeCharacterCount } from "../../shared/tool-output-limits.ts";
import {
  DEFAULT_READ_SESSION_CATEGORIES,
  readSessionOutput,
} from "../session-agent-read.ts";
import {
  boundedStructuredToolOutput,
  jsonRecord,
  records,
  testRecord,
} from "./session-agent-output-helpers.ts";
import { readSessionOutputFixture } from "./session-agent-read-fixtures.ts";

describe("read_session output", () => {
  test("uses record count as pagination without an independent byte cap", () => {
    const output = jsonRecord(
      readSessionOutput(
        readSessionOutputFixture({
          input: {
            categories: DEFAULT_READ_SESSION_CATEGORIES,
            limit: 1,
            sessionId: TEST_SESSION_DETAIL.id,
          },
          transcript: [
            testSessionMessage("one", "a".repeat(40_000), "user", 1),
            testSessionMessage("two", "😀".repeat(30_000), "assistant", 1),
          ],
        }),
      ),
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

  test("keeps a valid Unicode-bounded envelope and continuation metadata", () => {
    const maximum = MINIMUM_TOOL_OUTPUT_CHARACTERS;
    const rawOutput = readSessionOutput(
      readSessionOutputFixture({
        input: {
          categories: DEFAULT_READ_SESSION_CATEGORIES,
          limit: 2,
          sessionId: TEST_SESSION_DETAIL.id,
        },
        matchedRecords: 3,
        transcript: [
          testSessionMessage("one", "😀".repeat(2_000), "user", 1),
          testSessionMessage("two", "tail", "assistant", 2),
        ],
      }),
    );
    const output = boundedStructuredToolOutput(
      rawOutput,
      maximum,
      "read_session",
    );
    const parsed = jsonRecord(output);
    const metadata = testRecord(parsed["metadata"]);

    expect(unicodeCharacterCount(output)).toBeLessThanOrEqual(maximum);
    expect(metadata).toMatchObject({
      matchedRecords: 3,
      requestedLimit: 2,
      truncated: true,
    });
    expect(metadata["returnedRecords"]).toBe(1);
    expect(testRecord(metadata["truncation"])).toMatchObject({
      limit: true,
      outputCharacters: true,
      records: true,
    });
    expect(parsed["session"]).toEqual({
      id: TEST_SESSION_DETAIL.id,
      status: "idle",
      title: "Session",
    });
    expect(output).not.toContain("�");
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
