import { describe, expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import {
  DEFAULT_READ_SESSION_CATEGORIES,
  DEFAULT_READ_SESSION_LIMIT,
  readSessionOutput,
  type ReadSessionToolInput,
} from "../../sync-engine/session-agent-read.ts";
import {
  jsonRecord,
  parseTestJson,
  records,
  testNumber,
  testRecord,
  testString,
} from "./session-agent-output-helpers.ts";

const SESSION = { id: "session-1", status: "idle", title: "Inspect files" };
const TOOL_DEFINITION = {
  description: "Read a file",
  name: "read",
  parameters: {
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"],
    type: "object",
  },
};

function message(
  id: string,
  role: AgentSessionMessage["role"],
  content: string,
): AgentSessionMessage {
  return {
    content,
    createdAt: Number(id.replace(/\D/gu, "")) || 1,
    id,
    images: [],
    role,
    toolCallId: role === "tool" ? "call-1" : null,
    toolCalls:
      role === "assistant"
        ? [
            {
              arguments: '{"secret":"tool-history"}',
              id: "call-1",
              name: "bash",
            },
          ]
        : [],
    toolName: role === "tool" ? "bash" : null,
  };
}

function output(
  input: Partial<ReadSessionToolInput> = {},
  messages: readonly AgentSessionMessage[] = [
    message("message-1", "user", "first user"),
    message("message-2", "thinking", "private reasoning"),
    message("message-3", "assistant", "first assistant"),
    message("message-4", "tool", "tool-history result"),
    message("message-5", "user", "last user"),
  ],
): Readonly<Record<string, unknown>> {
  return testRecord(
    parseTestJson(
      readSessionOutput({
        input: {
          categories: DEFAULT_READ_SESSION_CATEGORIES,
          limit: DEFAULT_READ_SESSION_LIMIT,
          sessionId: SESSION.id,
          ...input,
        },
        messages,
        session: SESSION,
        systemPrompt: "base prompt\nworkspace instructions",
        toolDefinitions: [TOOL_DEFINITION],
      }),
    ),
  );
}

function content(read: Readonly<Record<string, unknown>>) {
  return testRecord(read["content"]);
}

function metadata(read: Readonly<Record<string, unknown>>) {
  return testRecord(read["metadata"]);
}

describe("bounded session reads", () => {
  test("uses conservative transcript defaults and minimal identity", () => {
    const read = output();
    const transcript = records(content(read)["records"]);

    expect(metadata(read)).toMatchObject({
      matchedRecords: 3,
      requestedLimit: 20,
      returnedRecords: 3,
      selectedCategories: ["user", "assistant"],
      truncated: false,
    });
    expect(read["session"]).toEqual(SESSION);
    expect(transcript.map((record) => record["role"])).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(read).not.toHaveProperty("model");
    expect(read).not.toHaveProperty("credentialId");
  });

  test("selects each category and composes bounded sections", () => {
    const system = output({ categories: ["system"] });
    expect(content(system)).toEqual({
      records: [],
      systemPrompt: "base prompt\nworkspace instructions",
    });

    const user = output({ categories: ["user"] });
    expect(
      records(content(user)["records"]).map((record) => record["content"]),
    ).toEqual(["first user", "last user"]);

    const assistant = output({ categories: ["assistant"] });
    const assistantRecords = records(content(assistant)["records"]);
    expect(assistantRecords).toHaveLength(1);
    expect(assistantRecords[0]).not.toHaveProperty("toolCalls");

    const tools = output({ categories: ["tools"] });
    expect(content(tools)["toolDefinitions"]).toEqual([TOOL_DEFINITION]);
    expect(content(tools)["records"]).toEqual([]);
  });

  test("combines sections and applies last-X after role filtering", () => {
    const read = output({
      categories: ["system", "user", "assistant", "tools"],
      limit: 2,
    });
    const transcript = records(content(read)["records"]);

    expect(transcript.map((record) => record["content"])).toEqual([
      "first assistant",
      "last user",
    ]);
    expect(metadata(read)).toMatchObject({
      matchedRecords: 3,
      returnedRecords: 2,
      truncated: true,
      truncation: { limit: true },
    });
    expect(JSON.stringify(read)).not.toContain("private reasoning");
    expect(JSON.stringify(read)).not.toContain("tool-history result");
    expect(JSON.stringify(read)).not.toContain("tool-history");
  });

  test("caps records, prompt, definitions, and the serialized output", () => {
    const hugeMessages = Array.from({ length: 100 }, (_, index) =>
      message(
        `message-${String(index + 1)}`,
        "user",
        `record-${String(index)}:${"x".repeat(20_000)}`,
      ),
    );
    const serialized = readSessionOutput({
      input: {
        categories: ["system", "user", "tools"],
        limit: 100,
        sessionId: SESSION.id,
      },
      messages: hugeMessages,
      session: SESSION,
      systemPrompt: "s".repeat(50_000),
      toolDefinitions: Array.from({ length: 100 }, (_, index) => ({
        description: "d".repeat(2_000),
        name: `tool-${String(index)}`,
        parameters: { properties: {}, required: [], type: "object" },
      })),
    });
    const read = jsonRecord(serialized);
    const truncation = testRecord(metadata(read)["truncation"]);

    expect(serialized.length).toBeLessThanOrEqual(32_768);
    expect(metadata(read)["truncated"]).toBe(true);
    expect(truncation["characterCap"]).toBe(true);
    expect(testNumber(metadata(read)["returnedRecords"])).toBeLessThan(100);
    expect(
      testString(records(content(read)["records"])[0]?.["content"]),
    ).toContain("[truncated]");
  });
});
