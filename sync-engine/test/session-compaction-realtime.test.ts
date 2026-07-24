import { describe, expect, test } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import type { SessionCompactionRealtimeEvent } from "../../shared/compaction-realtime.ts";
import { RealtimeHub } from "../../sync-engine/realtime-hub.ts";
import {
  collectCompactionEvent,
  TEST_COMPACTION_CONVERSATION,
  TEST_COMPACTION_SESSION,
  testCompactionTurn,
  testSessionAgentModels,
} from "./compaction-test-helpers.ts";
import { TestRealtimeSocket } from "./realtime-hub-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

function terminalPhases(events: readonly SessionCompactionRealtimeEvent[]) {
  return events.filter(
    ({ phase }) => phase === "cancel" || phase === "failure",
  );
}

describe("session compaction realtime lifecycle", () => {
  test("publishes start, separated deltas, reset, and completion only to the owner", async () => {
    const lifecycle: SessionCompactionRealtimeEvent[] = [];
    const published: { readonly payload: unknown; readonly userId: string }[] =
      [];
    let compactionDelta:
      | ((delta: {
          readonly content: string;
          readonly reset?: true;
          readonly thinking: string;
        }) => void)
      | undefined;
    const compactionModel: AgentModel = {
      complete: () => {
        compactionDelta?.({ content: "Discarded summary", thinking: "Old" });
        compactionDelta?.({ content: "", reset: true, thinking: "" });
        compactionDelta?.({
          content: "Final summary",
          thinking: "Fresh reasoning",
        });
        return Promise.resolve(
          testCompactionTurn("Final summary", "Fresh reasoning"),
        );
      },
    };
    const models = testSessionAgentModels({
      factory: (options) => {
        if (options.systemPrompt.includes("compact coding-agent")) {
          compactionDelta = options.onDelta;
          return compactionModel;
        }
        return new ScriptedAgentModel([]);
      },
      operationId: "operation-random-1",
      publish: (userId, payload) => {
        published.push({ payload, userId });
        collectCompactionEvent(lifecycle, payload);
      },
    });

    const compaction = models.createCompactor();
    const compacted = await compaction.compact(TEST_COMPACTION_CONVERSATION);
    compaction.complete();

    expect(compacted.summary).toBe("Final summary");
    expect(lifecycle).toEqual([
      {
        attempt: 0,
        operationId: "operation-random-1",
        phase: "start",
        sequence: 0,
        sessionId: TEST_COMPACTION_SESSION.id,
        type: "session_compaction",
      },
      {
        attempt: 0,
        operationId: "operation-random-1",
        phase: "delta",
        reasoning: "Old",
        sequence: 1,
        sessionId: TEST_COMPACTION_SESSION.id,
        summary: "Discarded summary",
        type: "session_compaction",
      },
      {
        attempt: 1,
        operationId: "operation-random-1",
        phase: "reset",
        sequence: 2,
        sessionId: TEST_COMPACTION_SESSION.id,
        type: "session_compaction",
      },
      {
        attempt: 1,
        operationId: "operation-random-1",
        phase: "delta",
        reasoning: "Fresh reasoning",
        sequence: 3,
        sessionId: TEST_COMPACTION_SESSION.id,
        summary: "Final summary",
        type: "session_compaction",
      },
      {
        attempt: 1,
        operationId: "operation-random-1",
        phase: "complete",
        sequence: 4,
        sessionId: TEST_COMPACTION_SESSION.id,
        type: "session_compaction",
      },
    ]);
    expect(published).toEqual(
      lifecycle.map((payload) => ({ payload, userId: "owner-1" })),
    );
  });

  test("delivers compaction events only to the authenticated owner", async () => {
    const hub = new RealtimeHub();
    const owner = new TestRealtimeSocket();
    const other = new TestRealtimeSocket();
    hub.setUser("owner-1", owner, true);
    hub.setUser("other-user", other, true);
    const models = testSessionAgentModels({
      factory: () => ({
        complete: () => Promise.resolve(testCompactionTurn("summary")),
      }),
      operationId: "owner-operation",
      publish: hub.publishUser.bind(hub),
    });
    const compaction = models.createCompactor();

    await compaction.compact(TEST_COMPACTION_CONVERSATION);
    compaction.complete();

    expect(
      owner.messages.map((message): unknown => JSON.parse(message)),
    ).toMatchObject([
      { phase: "start", type: "session_compaction" },
      { phase: "complete", type: "session_compaction" },
    ]);
    expect(other.messages).toEqual([]);
  });

  test("splits oversized provider chunks into decodable deltas", async () => {
    const events: SessionCompactionRealtimeEvent[] = [];
    const chunk = "x".repeat(16_384 * 2 + 7);
    const models = testSessionAgentModels({
      events,
      factory: (options) => {
        const emit = options.onDelta;
        const turn = testCompactionTurn("summary");
        return {
          complete: () => {
            emit?.({ content: chunk, thinking: chunk });
            return Promise.resolve(turn);
          },
        };
      },
      operationId: "operation-large-delta",
    });

    await models.createCompactor().compact(TEST_COMPACTION_CONVERSATION);

    const deltas = events.filter(({ phase }) => phase === "delta");
    expect(deltas).toHaveLength(3);
    const lengths = deltas.map((event) => {
      if (event.phase !== "delta") {
        return { reasoning: 0, summary: 0 };
      }
      return {
        reasoning: event.reasoning.length,
        summary: event.summary.length,
      };
    });
    expect(lengths).toEqual([
      { reasoning: 16_384, summary: 16_384 },
      { reasoning: 16_384, summary: 16_384 },
      { reasoning: 7, summary: 7 },
    ]);
  });

  test("emits one terminal failure or cancellation and never ordinary model deltas", async () => {
    for (const aborted of [false, true]) {
      const events: SessionCompactionRealtimeEvent[] = [];
      const ordinary: unknown[] = [];
      const controller = new AbortController();
      const models = testSessionAgentModels({
        events,
        factory: (options) => {
          const partial = { content: "partial", thinking: "private" };
          return {
            complete: () => {
              options.onDelta?.(partial);
              if (aborted) {
                controller.abort("test cancellation");
                return Promise.reject(
                  new DOMException("Stopped", "AbortError"),
                );
              }
              return Promise.reject(new Error("Provider failed"));
            },
          };
        },
        operationId: `operation-${String(aborted)}`,
        publish: (_userId, payload) => {
          if (payload["type"] === "session_delta") {
            ordinary.push(payload);
          }
        },
      });

      await expect(
        models
          .createCompactor()
          .compact(TEST_COMPACTION_CONVERSATION, controller.signal),
      ).rejects.toThrow();
      expect(events.at(-1)?.phase).toBe(aborted ? "cancel" : "failure");
      expect(terminalPhases(events)).toHaveLength(1);
      expect(ordinary).toEqual([]);
    }
  });

  test("bounds a failed realtime publisher without interrupting compaction", async () => {
    let publications = 0;
    let compactionDelta:
      | ((delta: {
          readonly content: string;
          readonly thinking: string;
        }) => void)
      | undefined;
    const models = testSessionAgentModels({
      factory: (options) => {
        compactionDelta = options.onDelta;
        return {
          complete: () => {
            compactionDelta?.({ content: "partial", thinking: "reasoning" });
            compactionDelta?.({ content: "ignored", thinking: "ignored" });
            return Promise.resolve(testCompactionTurn("summary"));
          },
        };
      },
      operationId: "operation-publisher-failure",
      publish: () => {
        publications += 1;
        throw new Error("Socket failed");
      },
    });
    const compaction = models.createCompactor();

    await expect(
      compaction.compact(TEST_COMPACTION_CONVERSATION),
    ).resolves.toMatchObject({ summary: "summary" });
    compaction.complete();
    expect(publications).toBe(1);
  });
});
