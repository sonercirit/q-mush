import { describe, expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import { TEST_AGENT_IMAGE } from "./agent-image-fixtures.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import {
  createScriptedAgentModel,
  type ScriptedAgentModel,
} from "./scripted-agent-model.ts";
import {
  closeContinuationSetup,
  compactionStep,
  continuationSetup,
  drainAndRead,
  expectContinuationRequests,
  expectTranscriptContent,
  removeContinuationRunner,
  startAndAwaitContinuation,
  startCompactingSession,
  stopContinuationSession,
} from "./session-continuation-test-helpers.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  completeRunnerCommand,
  expectedRunnerCommand,
  expectRunnerCommand,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

function expectFencedCompaction(options: {
  readonly after: unknown;
  readonly before: string;
  readonly model: ScriptedAgentModel;
  readonly status: "idle" | "stopped";
  readonly stale: string;
}): void {
  expect(options.model.requests).toHaveLength(2);
  expectTranscriptContent(options.after, options.before, true);
  expectTranscriptContent(options.after, options.stale, false);
  expectTranscriptContent(options.after, "Session failed:", false);
  expect(options.after).toMatchObject({
    costUsd: 0.2,
    currentContextTokens: 95_000,
    status: options.status,
  });
}

describe("session continuation", () => {
  test("continues automatically after final-step compaction", async () => {
    const continuation = continuationSetup(
      [
        compactionStep("Work complete before compaction.", {
          contextTokens: 95_000,
        }),
        compactionStep("Compacted handoff.", { costUsd: 0.1 }),
        compactionStep("Work complete after compaction.", {
          contextTokens: 96_000,
        }),
      ],
      { label: "Compaction test model", notifyRequest: 3 },
    );
    const continued = await startAndAwaitContinuation(continuation, "idle");

    expectContinuationRequests(continuation, "Compacted handoff.");
    expect(continuation.model.requests[1]).toContainEqual({
      content: "Work complete before compaction.",
      role: "assistant",
      toolCalls: [],
    });
    expectTranscriptContent(
      continued,
      "Work complete before compaction.",
      false,
    );
    expect(continued).toMatchObject({
      costUsd: 0.1,
      currentContextTokens: 96_000,
      messages: [
        { role: "user" },
        {
          content: "Work complete after compaction.",
          role: "assistant",
        },
      ],
      status: "idle",
    });
    expectTranscriptContent(continued, "Compacted handoff.", true);
    closeContinuationSetup(continuation.setup);
  });

  test("persists continuation failure after the atomic handoff", async () => {
    const continuation = continuationSetup(
      [
        compactionStep("Work before failed continuation.", {
          contextTokens: 95_000,
          costUsd: 0.2,
        }),
        compactionStep("Durable handoff.", { costUsd: 0.1 }),
      ],
      { label: "Continuation failure model", notifyRequest: 3 },
    );
    const failed = await startAndAwaitContinuation(continuation, "failed");

    expectContinuationRequests(continuation, "Durable handoff.");
    expectTranscriptContent(failed, "Work before failed continuation.", false);
    expect(failed).toMatchObject({
      costBasis: "reported",
      currentContextTokens: 0,
      messages: [
        { role: "user" },
        {
          content: "Session failed: The scripted model ran out of steps",
          role: "error",
        },
      ],
      status: "failed",
    });
    if (!isRecord(failed) || typeof failed["costUsd"] !== "number") {
      throw new Error("The failed session cost is unavailable");
    }
    expect(failed["costUsd"]).toBeCloseTo(0.3);
    closeContinuationSetup(continuation.setup);
  });

  test("fences an automatic compaction and continuation after a stop", async () => {
    const continuation = continuationSetup(
      [
        compactionStep("Work complete before stale compaction.", {
          contextTokens: 95_000,
          costUsd: 0.2,
        }),
        compactionStep("Stale compacted handoff.", { costUsd: 0.1 }),
      ],
      { blockRequest: 2, label: "Compaction authority model" },
    );
    await startCompactingSession(continuation);
    await continuation.entered;

    const stopping = stopContinuationSession(continuation);
    continuation.blocked.resolve(undefined);
    const before = await stopping;
    const after = await drainAndRead(continuation.setup);

    expect(after).toEqual(before);
    expectFencedCompaction({
      after,
      before: "Work complete before stale compaction.",
      model: continuation.model,
      stale: "Stale compacted handoff.",
      status: "stopped",
    });
    closeContinuationSetup(continuation.setup);
  });

  test("fences an automatic compaction after runner removal", async () => {
    const continuation = continuationSetup(
      [
        compactionStep("Work before runner removal.", {
          contextTokens: 95_000,
          costUsd: 0.2,
        }),
        compactionStep("Runner-removed stale handoff.", { costUsd: 0.1 }),
      ],
      { blockRequest: 2, label: "Runner removal compaction model" },
    );
    await startCompactingSession(continuation);
    await continuation.entered;

    const removal = removeContinuationRunner(continuation.setup);
    continuation.blocked.resolve(undefined);
    await removal;
    const after = await sessionDetail(continuation.setup.sessions);

    expectFencedCompaction({
      after,
      before: "Work before runner removal.",
      model: continuation.model,
      stale: "Runner-removed stale handoff.",
      status: "idle",
    });
    expect(after).toMatchObject({ runnerRequired: true });
    closeContinuationSetup(continuation.setup);
  });

  test("propagates configured limits to a real runner command", async () => {
    const configured = {
      executionLimitMinutes: 7,
      outputLimitCharacters: 12_345,
    } as const;
    const finalStep = {
      content: "Configured limits complete.",
      toolCalls: [],
    };
    const model = createScriptedAgentModel([
      {
        content: "Reading.",
        toolCalls: [
          {
            arguments: '{"path":"README.md"}',
            id: "configured-read",
            name: "read",
          },
        ],
      },
      finalStep,
    ]);
    const setup = connectedSessionSetup(model, "api_key", undefined, {
      toolSettings: { read: () => configured },
    });
    const initialRequest = createSessionRequest();
    const created = await setup.sessions.collection(initialRequest);
    expect(created.status).toBe(201);
    await completeAgentFileLookup(setup);

    const configuredCall = {
      arguments: { path: "README.md" },
      executionLimitSeconds: 7 * 60,
      outputLimitCharacters: configured.outputLimitCharacters,
      tool: "read" as const,
    };
    await expectRunnerCommand(
      setup,
      expectedRunnerCommand(configuredCall),
      "The configured runner command was not delivered",
    );
    completeRunnerCommand(setup, "configured output");
    await waitForSessionValue(
      () => sessionDetail(setup.sessions),
      hasSessionStatus("idle"),
    );
    setup.database.$client.close();
  });

  test("spawns a session, executes tools on its runner, and accepts follow-ups", async () => {
    const model = createScriptedAgentModel([
      {
        content: "Reading the file.",
        contextTokens: 12_345,
        thinking: "I need to inspect README before answering.",
        toolCalls: [
          {
            arguments: '{"path":"README.md"}',
            id: "model-tool-1",
            name: "read",
          },
        ],
      },
      { content: "README inspected.", contextTokens: 13_000, toolCalls: [] },
      { content: "Follow-up complete.", contextTokens: 14_000, toolCalls: [] },
      {
        content: "Continuation complete.",
        contextTokens: 15_000,
        toolCalls: [],
      },
    ]);
    const setup = connectedSessionSetup(model);
    const { database, selectedReasoningEfforts, sessions } = setup;
    const createResponse = await sessions.collection(createSessionRequest());

    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toMatchObject({
      currentContextTokens: 0,
      autoCompact: true,
      id: SESSION_ID,
      maxContextTokens: null,
      reasoningEffort: "high",
      status: "queued",
      title: "Inspect README.md",
    });
    await completeAgentFileLookup(setup);
    await expectRunnerCommand(
      setup,
      expectedRunnerCommand({
        arguments: { path: "README.md" },
        tool: "read",
      }),
      "The runner did not receive an agent command",
    );

    const resultResponse = completeRunnerCommand(setup, "# Q Mush");
    expect(resultResponse.status).toBe(204);
    const idle = await waitForSessionValue(
      () => sessionDetail(sessions),
      hasSessionStatus("idle"),
    );
    expectTranscriptContent(idle, "README inspected.", true);
    expectTranscriptContent(
      idle,
      "I need to inspect README before answering.",
      true,
    );
    expectTranscriptContent(idle, "# Q Mush", true);
    expect(idle).toMatchObject({ currentContextTokens: 13_000 });

    const followUp = await sessions.message(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/messages`,
        { images: [TEST_AGENT_IMAGE], prompt: "Now summarize it" },
        "POST",
      ),
      SESSION_ID,
    );
    expect(followUp.status).toBe(202);
    await completeAgentFileLookup(setup);
    const continued = await waitForSessionValue(
      () => sessionDetail(sessions),
      (value) => {
        const serialized = JSON.stringify(value);
        return (
          hasSessionStatus("idle")(value) &&
          serialized.includes("Follow-up complete.")
        );
      },
    );
    const followUpRequest = model.requests[2];
    expect(followUpRequest).toBeDefined();
    expectTranscriptContent(continued, "Now summarize it", true);
    expect(followUpRequest).toContainEqual({
      content: "Now summarize it",
      images: [TEST_AGENT_IMAGE],
      role: "user",
    });

    const resumed = await sessions.continue(
      createAuthenticatedRequest(
        `${SESSIONS_PATH}/${SESSION_ID}/continue`,
        undefined,
        "POST",
      ),
      SESSION_ID,
    );
    expect(resumed.status).toBe(202);
    await completeAgentFileLookup(setup);
    const continuationRequest = await waitForSessionValue(
      () => model.requests[3],
      (value) => value !== undefined,
    );
    if (followUpRequest === undefined) {
      throw new Error("The model did not receive the follow-up request");
    }
    expect(continuationRequest).toEqual([
      ...followUpRequest.filter(
        (message) => message.role !== "user" || message.content !== "Continue.",
      ),
      { content: "Follow-up complete.", role: "assistant", toolCalls: [] },
      { content: "Continue.", role: "user" },
    ]);
    expect(selectedReasoningEfforts).toEqual(["high", "high", "high"]);
    database.$client.close();
  });
});
