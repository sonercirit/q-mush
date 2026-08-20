import { expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { startedAtUtc } from "../../shared/test/session-fixtures.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../../solid/session-transcript-filters.ts";
import { testToolStream } from "./session-tool-stream-fixtures.ts";
import {
  assistantToolCall,
  message,
  renderMessages,
  toolResult,
} from "./session-transcript-test-helpers.tsx";

test("shows per-step timing for a call, tools, and following call", () => {
  const startedAt = startedAtUtc();
  const firstAssistantAt = startedAt + 1_000;
  const toolSettledAt = startedAt + 8_000;
  const finalAssistantAt = startedAt + 13_000;
  const call = {
    ...assistantToolCall({
      arguments: '{"path":"README.md"}',
      id: "timed-read",
      name: "read",
    }),
    createdAt: firstAssistantAt,
  };
  const result = {
    ...toolResult({
      content: "Timed output",
      id: "timed-read",
      name: "read",
    }),
    createdAt: toolSettledAt,
  };
  const html = renderMessages([
    {
      ...message("user-timed", "Timed request", "user"),
      createdAt: startedAt,
    },
    {
      ...call,
      tokenUsage: {
        cacheWriteInputTokens: 0,
        cachedInputTokens: 0,
        inputTokens: 400,
        outputTokens: 30,
      },
    },
    result,
    {
      ...message("thinking-timed", "Considering output", "thinking"),
      createdAt: toolSettledAt + 2_000,
    },
    {
      ...message("assistant-timed", "Timed response", "assistant"),
      createdAt: finalAssistantAt,
      tokenUsage: {
        cacheWriteInputTokens: 0,
        cachedInputTokens: 300,
        inputTokens: 900,
        outputTokens: 40,
      },
    },
  ]);

  expect(html.match(/data-step-timing="completed"/gu)).toHaveLength(2);
  expect(html).not.toContain("data-turn-timing");
  for (const duration of ["Duration: 8s", "Duration: 5s"]) {
    expect(html).toContain(duration);
  }
  // The second step read 300 of the 400 tokens its predecessor made cacheable;
  // the first step has no cacheable prefix, so it shows no rate.
  expect(html.match(/Cache: /gu)).toHaveLength(1);
  expect(html).toContain("Cache: 75%");
  for (const timestamp of [startedAt, toolSettledAt, finalAssistantAt]) {
    expect(html).toContain(`datetime="${new Date(timestamp).toISOString()}"`);
  }
});

test("renders durable settlement time for a terminal step", () => {
  const durableStartedAt = Date.UTC(2026, 6, 27, 12, 0, 0);
  const durableMessageAt = durableStartedAt + 2_000;
  const durableEndedAt = durableStartedAt + 3_000;
  const durableTurnId = "durable-turn";
  const messages = [
    {
      ...message("durable-user", "Durable request", "user"),
      createdAt: durableStartedAt,
      turnId: durableTurnId,
    },
    {
      ...message("durable-assistant", "Durable response", "assistant"),
      createdAt: durableMessageAt,
      tokenUsage: {
        cacheWriteInputTokens: 20,
        cachedInputTokens: 300,
        inputTokens: 400,
        outputTokens: 50,
      },
      turnId: durableTurnId,
    },
  ];
  const html = renderMessages(
    messages,
    AGENT_SESSION_TOOL_NAMES,
    DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    null,
    undefined,
    [
      {
        boundaryMessageId: "durable-assistant",
        endedAt: durableEndedAt,
        executionGeneration: 1,
        id: durableTurnId,
        startedAt: durableStartedAt,
        toolSettings: DEFAULT_TOOL_SETTINGS,
      },
    ],
  );

  const completedTimingCount = html.match(
    /data-step-timing="completed"/gu,
  )?.length;
  expect(completedTimingCount).toBe(1);
  expect(html).toContain("Duration: 3s");
  // A session's first step has no cacheable prefix, so no rate is shown.
  expect(html).not.toContain("Cache:");
  const settlementDateTime = new Date(durableEndedAt).toISOString();
  expect(html).toContain(`datetime="${settlementDateTime}"`);
});

function renderedElementTexts(
  html: string,
  pattern: RegExp,
): readonly string[] {
  return [...html.matchAll(pattern)].map((match) =>
    (match[1] ?? "").replace(/<[^>]*>/gu, "").replaceAll("&quot;", '"'),
  );
}

const SLEEP_DURATION_ELEMENT_PATTERN =
  /<p class="[^"]*text-sm text-cyan-100[^"]*">([^<]*)<\/p>/gu;
const SLEEP_RESULT_TIMING_ELEMENT_PATTERN =
  /<p class="[^"]*mt-1 text-xs text-slate-400[^"]*">([^<]*)<\/p>/gu;
const JSON_CODE_ELEMENT_PATTERN =
  /<pre[^>]*data-language="json"[^>]*>([\s\S]*?)<\/pre>/gu;

test("renders sleep calls and results with human-readable durations", () => {
  const cases = [
    {
      arguments: '{"durationSeconds":59}',
      duration: "59s",
      id: "seconds-under-minute",
    },
    {
      arguments: '{"durationSeconds":60}',
      duration: "1m",
      id: "seconds-minute",
    },
    {
      arguments: '{"durationSeconds":61}',
      duration: "1m 1s",
      id: "seconds-over-minute",
    },
    {
      arguments: '{"durationSeconds":1800}',
      duration: "30m",
      id: "seconds-maximum",
    },
    {
      // Transcripts recorded under the historical 3,600s schema keep
      // their friendly rendering.
      arguments: '{"durationSeconds":3600}',
      duration: "1h",
      id: "seconds-historical-hour",
    },
    {
      arguments: '{"durationSeconds":90}',
      duration: "1m 30s",
      id: "seconds",
      result:
        "Steering arrived; woke early (actual 75000 ms, expected 90000 ms).",
      resultTiming: "Actual: 1m 15s · Expected: 1m 30s",
    },
    {
      arguments: '{"durationMs":1200000}',
      duration: "20m",
      id: "legacy-milliseconds",
      result:
        "Slept for the full duration (actual 1200000 ms, expected 1200000 ms).",
      resultTiming: "Actual: 20m · Expected: 20m",
    },
  ];

  for (const case_ of cases) {
    const messages = [
      assistantToolCall({
        arguments: case_.arguments,
        id: case_.id,
        name: "sleep",
      }),
    ];
    if (case_.result !== undefined) {
      messages.push(
        toolResult({
          content: case_.result,
          id: case_.id,
          name: "sleep",
        }),
      );
    }
    const html = renderMessages(messages);

    expect(renderedElementTexts(html, SLEEP_DURATION_ELEMENT_PATTERN)).toEqual([
      `Duration: ${case_.duration}`,
    ]);
    expect(
      renderedElementTexts(html, SLEEP_RESULT_TIMING_ELEMENT_PATTERN),
    ).toEqual(case_.resultTiming === undefined ? [] : [case_.resultTiming]);
    expect(html).not.toContain(case_.arguments.replaceAll('"', "&quot;"));
  }
});

test("falls back to raw sleep arguments when the duration is malformed", () => {
  for (const [id, arguments_, expectedJson] of [
    ["missing", '{"timeout":1}', '{\n  "timeout": 1\n}'],
    ["empty", "{}", "{}"],
    [
      "seconds-string",
      '{"durationSeconds":"60"}',
      '{\n  "durationSeconds": "60"\n}',
    ],
    [
      "milliseconds-string",
      '{"durationMs":"60000"}',
      '{\n  "durationMs": "60000"\n}',
    ],
  ] as const) {
    const html = renderMessages([
      assistantToolCall({ arguments: arguments_, id, name: "sleep" }),
    ]);

    expect(html).toContain("Tool call · sleep");
    expect(html).not.toContain("text-sm text-cyan-100");
    expect(renderedElementTexts(html, JSON_CODE_ELEMENT_PATTERN)).toContain(
      expectedJson,
    );
  }
});

test("uses each persisted turn's configured sleep limit", () => {
  const historicalCall = {
    ...assistantToolCall({
      arguments: '{"durationSeconds":7200}',
      id: "historical-configured-sleep",
      name: "sleep",
    }),
    turnId: "historical-turn",
  };
  const latestCall = {
    ...assistantToolCall({
      arguments: '{"durationSeconds":7200}',
      id: "latest-configured-sleep",
      name: "sleep",
    }),
    turnId: "latest-turn",
  };
  const html = renderMessages(
    [historicalCall, latestCall],
    AGENT_SESSION_TOOL_NAMES,
    DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    null,
    undefined,
    [
      {
        boundaryMessageId: historicalCall.id,
        endedAt: 2,
        executionGeneration: 1,
        id: "historical-turn",
        startedAt: 1,
        toolSettings: { ...DEFAULT_TOOL_SETTINGS, executionLimitMinutes: 120 },
      },
      {
        boundaryMessageId: latestCall.id,
        endedAt: 4,
        executionGeneration: 2,
        id: "latest-turn",
        startedAt: 3,
        toolSettings: { ...DEFAULT_TOOL_SETTINGS, executionLimitMinutes: 30 },
      },
    ],
  );

  expect(renderedElementTexts(html, SLEEP_DURATION_ELEMENT_PATTERN)).toEqual([
    "Duration: 2h",
  ]);
  expect(
    renderedElementTexts(html, JSON_CODE_ELEMENT_PATTERN).join(" "),
  ).toContain('"durationSeconds": 7200');
});

const renderLatestConfiguredSleep = (
  messageId: string,
  liveStreams: readonly ReturnType<typeof testToolStream>[],
): string => {
  const streamedMessage = {
    ...assistantToolCall({
      arguments: '{"durationSeconds":7200}',
      id: "message-sleep",
      name: "sleep",
    }),
    id: messageId,
  };
  return renderMessages(
    [streamedMessage],
    AGENT_SESSION_TOOL_NAMES,
    DEFAULT_SESSION_TRANSCRIPT_FILTERS,
    null,
    undefined,
    [
      {
        boundaryMessageId: streamedMessage.id,
        endedAt: null,
        executionGeneration: 2,
        id: "latest-turn",
        startedAt: 1,
        toolSettings: { ...DEFAULT_TOOL_SETTINGS, executionLimitMinutes: 120 },
      },
    ],
    liveStreams,
    "running",
  );
};

test("uses the latest configured limit for inline streamed messages without a live tool stream", () => {
  const html = renderLatestConfiguredSleep("stream:assistant", []);

  expect(html).toContain("Duration: 2h");
});

test("uses the latest configured limit for inline live sleep streams", () => {
  const html = renderLatestConfiguredSleep("stream:live-assistant", [
    testToolStream("message-sleep", '{"durationSeconds":7200}', "sleep"),
  ]);

  expect(html).toContain("Duration: 2h");
});
