import { expect, test } from "vitest";
import {
  readAgentModelCatalog,
  readSessionDetail,
} from "../../solid/session-codec.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
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

test("projects session details to summary-only fields", () => {
  const usage = {
    cacheWriteInputTokens: 0,
    cachedInputTokens: 0,
    inputTokens: 1,
    lastInputTokens: 1,
    outputTokens: 0,
    reportedStepCount: 1,
    stepCount: 1,
  };
  const summary = summaryFromDetail({
    ...DETAIL,
    segmentTokenUsage: usage,
    tokenUsage: usage,
    turns: [],
  });

  for (const detailOnlyKey of [
    "agentFile",
    "messages",
    "modelContextTokens",
    "pendingInputs",
    "segmentTokenUsage",
    "tokenUsage",
    "turns",
  ]) {
    expect(summary).not.toHaveProperty(detailOnlyKey);
  }
  expect(summary.adaptiveThinking).toBe(DETAIL.adaptiveThinking);
});

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

test("reads generic provider sessions", () => {
  expect(readSessionDetail({ ...DETAIL, provider: "generic" }).provider).toBe(
    "generic",
  );
});

test("reads and validates a running session pending component", () => {
  const pending = { component: "provider_admission" as const, since: 7 };
  expect(
    readSessionDetail({
      ...DETAIL,
      runtimePending: pending,
      status: "running",
    }).runtimePending,
  ).toEqual(pending);
  for (const invalid of [
    { ...DETAIL, runtimePending: undefined },
    { ...DETAIL, runtimePending: pending },
    {
      ...DETAIL,
      runtimePending: { component: "unknown", since: 7 },
      status: "running",
    },
    {
      ...DETAIL,
      runtimePending: { component: "provider_request", since: 1.5 },
      status: "running",
    },
    // Keep this construction distinct from the adjacent fractional-value case
    // so the zero-threshold CPD check does not conflate separate codec bounds.
    Object.assign({}, DETAIL, {
      runtimePending: { component: "provider_request", since: -1 },
      status: "running",
    }),
  ]) {
    expectInvalidSession(invalid);
  }
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

test("reads active and completed spawned-session hierarchy metadata", () => {
  const active = {
    ...DETAIL,
    parentExecutionGeneration: 2,
    parentSessionId: "parent-session",
  };
  const completed = { ...active, parentExecutionGeneration: null };

  expect(readSessionDetail(active)).toMatchObject(active);
  expect(readSessionDetail(completed)).toMatchObject(completed);
  expectInvalidSession({
    ...DETAIL,
    parentExecutionGeneration: 2,
    parentSessionId: null,
  });
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
  expect(
    readSessionDetail({
      ...DETAIL,
      restartHandoff: { ...handoff, operation: "compact_and_continue" },
      status: "paused",
    }).restartHandoff,
  ).toMatchObject({ operation: "compact_and_continue" });
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
  expect(
    readSessionDetail({
      ...DETAIL,
      agentFile: { content: "Custom", name: "config/OTHER.md" },
    }).agentFile,
  ).toEqual({
    content: "Custom",
    name: "config/OTHER.md",
  });
  expect(() =>
    readSessionDetail({
      ...DETAIL,
      agentFile: { content: "Ignored", name: "" },
    }),
  ).toThrow("invalid agent file");
});

function modelCatalogValue(
  inputModalities: unknown,
  includeInput = true,
  maxOutputTokens: number | null | "omitted" = null,
): Readonly<Record<string, unknown>> {
  return {
    defaultModel: "gpt-test",
    models: [
      {
        adaptiveThinking: null,
        contextWindow: 128_000,
        id: "gpt-test",
        ...(includeInput ? { inputModalities } : {}),
        label: "GPT Test",
        ...(maxOutputTokens === "omitted" ? {} : { maxOutputTokens }),
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

test("rejects omitted, non-positive, and fractional output token limits", () => {
  // Every server path emits the key; the codec treats omission as invalid
  // like the sibling context limits.
  for (const invalid of ["omitted" as const, -5, 0, 1.5]) {
    expect(() =>
      readAgentModelCatalog(modelCatalogValue(["text"], true, invalid)),
    ).toThrow("invalid agent model");
  }
});

test("requires explicit context, cost, and compaction metadata from session responses", () => {
  for (const invalid of [
    { ...DETAIL, autoCompact: undefined },
    { ...DETAIL, idleCompact: "yes" },
    { ...DETAIL, costBasis: undefined },
    { ...DETAIL, stepStartedAt: undefined },
    { ...DETAIL, stepStartedAt: 1.5 },
    { ...DETAIL, costBasis: "none", costUsd: 1 },
    { ...DETAIL, maxContextTokens: undefined },
    { ...DETAIL, maxOutputTokens: 0 },
    { ...DETAIL, maxOutputTokens: 1.5 },
    { ...DETAIL, modelContextTokens: undefined },
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
