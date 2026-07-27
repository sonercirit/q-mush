import { expect, test } from "vitest";
import {
  readAgentModelCatalog,
  readSessionDetail,
} from "../../solid/session-codec.ts";
import {
  TEST_AGENT_IMAGE,
  testUserImageMessage,
} from "./agent-image-fixtures.ts";
import { singleChoicePendingQuestions } from "./ask-questions-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const INVALID_SESSION_ERROR = "invalid agent session";

function expectInvalidSession(value: unknown): void {
  expect(() => readSessionDetail(value)).toThrow(INVALID_SESSION_ERROR);
}

const DETAIL = {
  ...TEST_SESSION_DETAIL,
  agentFile: { content: "Project instructions", name: "CLAUDE.md" },
};

const RESTART_HANDOFF = {
  executionGeneration: DETAIL.generation,
  operation: "agent",
  pendingInput: [],
  requestedBy: "server",
  restartId: "restart-1",
} as const;

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

test("reads durable pending-input request identities", () => {
  const pending = {
    clientRequestId: "request-1",
    content: "Continue",
    createdAt: 3,
    id: "pending-1",
    images: [],
    kind: "follow_up",
  } as const;

  expect(
    readSessionDetail({ ...DETAIL, pendingInputs: [pending] }).pendingInputs,
  ).toEqual([pending]);
  expect(() =>
    readSessionDetail({
      ...DETAIL,
      pendingInputs: [{ ...pending, clientRequestId: undefined }],
    }),
  ).toThrow("invalid pending session input");
});

test("reads persisted session error messages", () => {
  const error = {
    content: "The provider connection failed",
    createdAt: 3,
    id: "error-1",
    images: [],
    role: "error",
    toolCallId: null,
    toolCalls: [],
    toolName: null,
  };

  expect(readSessionDetail({ ...DETAIL, messages: [error] }).messages).toEqual([
    error,
  ]);
});

test("requires runner reassignment metadata in session responses", () => {
  expect(
    readSessionDetail({ ...DETAIL, runnerRequired: true }).runnerRequired,
  ).toBe(true);
  expect(() =>
    readSessionDetail({ ...DETAIL, runnerRequired: undefined }),
  ).toThrow("invalid agent session");
});

test("strictly validates question pauses and lifecycle status coupling", () => {
  const pendingQuestions = singleChoicePendingQuestions(
    "request-1",
    DETAIL.generation,
    3,
  );

  expect(
    readSessionDetail({
      ...DETAIL,
      pendingQuestions,
      status: "paused",
    }).pendingQuestions,
  ).toEqual(pendingQuestions);
  for (const invalid of [
    { ...DETAIL, pendingQuestions },
    {
      ...DETAIL,
      pendingQuestions: {
        ...pendingQuestions,
        executionGeneration: DETAIL.generation + 1,
      },
      status: "paused",
    },
    {
      ...DETAIL,
      pendingQuestions,
      restartHandoff: RESTART_HANDOFF,
      status: "paused",
    },
  ]) {
    expectInvalidSession(invalid);
  }
});

test("strictly validates restart handoffs and lifecycle status coupling", () => {
  const handoff = RESTART_HANDOFF;

  expect(
    readSessionDetail({
      ...DETAIL,
      restartHandoff: handoff,
      status: "paused",
    }).restartHandoff,
  ).toEqual(handoff);
  for (const status of ["queued", "running"] as const) {
    expect(
      readSessionDetail({ ...DETAIL, restartHandoff: handoff, status }),
    ).toMatchObject({ restartHandoff: handoff, status });
  }
  for (const invalid of [
    { ...DETAIL, restartHandoff: handoff, status: "idle" },
    { ...DETAIL, restartHandoff: null, status: "paused" },
    {
      ...DETAIL,
      restartHandoff: { ...handoff, unexpected: true },
      status: "paused",
    },
    {
      ...DETAIL,
      restartHandoff: { ...handoff, pendingInput: ["message"] },
      status: "paused",
    },
    {
      ...DETAIL,
      restartHandoff: { ...handoff, restartId: "x".repeat(201) },
      status: "paused",
    },
    {
      ...DETAIL,
      restartHandoff: {
        ...handoff,
        executionGeneration: DETAIL.generation + 1,
      },
      status: "paused",
    },
  ]) {
    expect(() => readSessionDetail(invalid)).toThrow("invalid agent session");
  }
});

test("reads a session's tool and skill selection", () => {
  expect(readSessionDetail(DETAIL).tools).toEqual(DETAIL.tools);
  expect(() =>
    readSessionDetail({ ...DETAIL, tools: ["read", "read"] }),
  ).toThrow("invalid agent session");
  expect(() =>
    readSessionDetail({ ...DETAIL, tools: ["unknown_tool"] }),
  ).toThrow("invalid agent session");
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
    expectInvalidSession(invalid);
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
