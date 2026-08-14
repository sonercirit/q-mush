import { describe, expect, test } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { testSessionMessage } from "../../shared/test/session-fixtures.ts";
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
    ...testSessionMessage(
      id,
      content,
      role,
      Number(id.replace(/\D/gu, "")) || 1,
    ),
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

function messageList(
  length: number,
  role: AgentSessionMessage["role"],
  content: (index: number) => string,
): readonly AgentSessionMessage[] {
  return Array.from({ length }, (_, index) =>
    message(`message-${String(index + 1)}`, role, content(index)),
  );
}

function readSession(options: Parameters<typeof readSessionOutput>[0]): {
  readonly parsed: Readonly<Record<string, unknown>>;
  readonly serialized: string;
} {
  const serialized = readSessionOutput(options);
  return { parsed: jsonRecord(serialized), serialized };
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
  matchedRecords?: number,
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
        ...(matchedRecords === undefined ? {} : { matchedRecords }),
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
    expect(assistantRecords).toEqual([
      expect.objectContaining({
        content: "first assistant",
        role: "assistant",
        toolCalls: [
          {
            arguments: '{"secret":"tool-history"}',
            id: "call-1",
            name: "bash",
          },
        ],
      }),
    ]);

    const thinking = output({ categories: ["thinking"] });
    expect(records(content(thinking)["records"])).toEqual([
      expect.objectContaining({
        content: "private reasoning",
        id: "message-2",
        role: "thinking",
      }),
    ]);

    const tool = output({ categories: ["tool"] });
    expect(records(content(tool)["records"])).toEqual([
      expect.objectContaining({
        content: "tool-history result",
        id: "message-4",
        role: "tool",
        toolCallId: "call-1",
        toolName: "bash",
      }),
    ]);

    const tools = output({ categories: ["tools"] });
    expect(content(tools)["toolDefinitions"]).toEqual([TOOL_DEFINITION]);
    expect(content(tools)["records"]).toEqual([]);

    // Truncation and failure notices persist as error rows; a parent
    // reading a child's transcript must be able to select them.
    const error = output({ categories: ["error"] }, [
      message("message-1", "assistant", "Partial answer"),
      message("message-2", "error", "The response was truncated"),
    ]);
    expect(records(content(error)["records"])).toEqual([
      expect.objectContaining({
        content: "The response was truncated",
        id: "message-2",
        role: "error",
      }),
    ]);
  });

  test("combines sections and applies last-X after role filtering", () => {
    const read = output({
      categories: ["system", "user", "assistant", "thinking", "tool", "tools"],
      limit: 2,
    });
    const transcript = records(content(read)["records"]);

    expect(transcript.map((record) => record["content"])).toEqual([
      "tool-history result",
      "last user",
    ]);
    expect(metadata(read)).toMatchObject({
      matchedRecords: 5,
      returnedRecords: 2,
      truncated: true,
      truncation: { limit: true },
    });
    expect(JSON.stringify(read)).toContain("tool-history result");
    expect(JSON.stringify(read)).not.toContain("private reasoning");
  });

  test("counts limit truncation even when the store prelimits records", () => {
    const read = output(
      { limit: 2 },
      [
        message("message-4", "assistant", "fourth"),
        message("message-5", "user", "fifth"),
      ],
      5,
    );

    const readMetadata = metadata(read);
    expect(readMetadata).toMatchObject({
      matchedRecords: 5,
      requestedLimit: 2,
      returnedRecords: 2,
      truncation: { limit: true },
      truncated: true,
    });
  });

  test("reports records dropped to satisfy the total output byte cap", () => {
    const serialized = readSessionOutput({
      input: {
        categories: ["user"],
        limit: 10,
        sessionId: SESSION.id,
      },
      messages: Array.from({ length: 10 }, (_, index) =>
        message(
          `aggregate-${String(index + 1)}`,
          "user",
          `${String(index)}:${"x".repeat(3_900)}`,
        ),
      ),
      session: SESSION,
      systemPrompt: "",
      toolDefinitions: [],
    });
    const read = jsonRecord(serialized);

    expect(metadata(read)).toMatchObject({
      matchedRecords: 10,
      requestedLimit: 10,
      returnedRecords: 8,
      truncated: true,
      truncation: {
        characterCap: false,
        limit: false,
        outputBytes: true,
        records: true,
      },
    });
    expect(testNumber(metadata(read)["returnedRecords"])).toBeLessThan(10);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(32_768);
  });

  test("caps records, prompt, definitions, and the serialized output", () => {
    const hugeMessages = messageList(
      100,
      "user",
      (index) => `record-${String(index)}:${"x".repeat(20_000)}`,
    );
    const bounded = readSession({
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
    const { parsed: read, serialized } = bounded;
    const capMetadata = metadata(read);
    const truncation = testRecord(capMetadata["truncation"]);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(32_768);
    expect(capMetadata["truncated"]).toBe(true);
    expect(truncation["characterCap"]).toBe(true);
    expect(testNumber(capMetadata["returnedRecords"])).toBeLessThan(100);
    const firstRecord = records(content(read)["records"])[0];
    expect(testString(firstRecord?.["content"])).toContain("[truncated]");
  });

  test("preserves Unicode boundaries and reports system truncation after records drop", () => {
    const unicode = "😀".repeat(20_000);
    const bounded = readSession({
      input: {
        categories: ["system", "user"],
        limit: 100,
        sessionId: SESSION.id,
      },
      matchedRecords: 101,
      messages: messageList(100, "user", () => unicode),
      session: SESSION,
      systemPrompt: unicode,
      toolDefinitions: [],
    });
    const { parsed: read, serialized } = bounded;
    const readMetadata = metadata(read);
    const truncation = testRecord(readMetadata["truncation"]);

    const unicodeBytes = Buffer.byteLength(serialized, "utf8");
    expect(unicodeBytes).toBeLessThanOrEqual(32_768);
    expect(serialized).not.toContain("�");
    expect(readMetadata).toMatchObject({
      matchedRecords: 101,
      requestedLimit: 100,
      truncated: true,
    });
    expect(truncation).toMatchObject({
      characterCap: true,
      limit: true,
      systemPrompt: true,
    });
  });
});
