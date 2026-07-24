import { expect, test } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import type { AgentModel } from "../../shared/agent-loop.ts";
import type { SessionCompactionRealtimeEvent } from "../../shared/compaction-realtime.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { compactSessionConversation } from "../../sync-engine/session-agent-runtime.ts";
import {
  collectCompactionEvent,
  TEST_COMPACTION_CONVERSATION,
  TEST_COMPACTION_CREDENTIAL,
  TEST_COMPACTION_SESSION,
  testCompactionTurn,
} from "./compaction-test-helpers.ts";

function runtime(options: {
  readonly compact?: () => void;
  readonly model: AgentModel;
  readonly updateUsage?: () => void;
}) {
  const events: SessionCompactionRealtimeEvent[] = [];
  const conversation = TEST_COMPACTION_CONVERSATION;
  const broker = new RunnerCommandBroker({
    deliver: (runnerId, command) => {
      if (command.tool !== RUNNER_AGENT_FILE_COMMAND) {
        return false;
      }
      queueMicrotask(() => {
        broker.complete(runnerId, command.id, "null");
      });
      return true;
    },
  });
  return {
    events,
    value: {
      braveSearch: { execute: () => Promise.resolve("") },
      broker,
      credential: TEST_COMPACTION_CREDENTIAL,
      detail: { ...TEST_COMPACTION_SESSION, status: "running" as const },
      modelFactory: () => options.model,
      now: () => 1,
      notify: () => undefined,
      operationId: () => "manual-operation",
      publishUser: (
        _userId: string,
        payload: Readonly<Record<string, unknown>>,
      ) => {
        collectCompactionEvent(events, payload);
      },
      sessionTools: {
        continueSession: () => Promise.resolve(""),
        listSessions: () => "",
        readSession: () => "",
        sendToSession: () => Promise.resolve(""),
        spawnSession: () => Promise.resolve(""),
        stopSession: () => "",
      },
      signal: new AbortController().signal,
      store: {
        appendAgentMessage: () => undefined,
        compact: () => options.compact?.(),
        conversation: () => conversation,
        setAgentFile: () => undefined,
        updateUsage: () => options.updateUsage?.(),
      },
      userId: "owner-1",
    },
  };
}

function expectManualPhases(
  setup: ReturnType<typeof runtime>,
  terminal: "complete" | "failure",
): void {
  expect(setup.events.map(({ phase }) => phase)).toEqual(["start", terminal]);
}

test("manual compaction completes after the final transaction", async () => {
  let persisted = false;
  const setup = runtime({
    compact: () => {
      persisted = true;
    },
    model: {
      complete: () => Promise.resolve(testCompactionTurn("Final summary")),
    },
  });

  await compactSessionConversation(setup.value);

  expect(persisted).toBe(true);
  expectManualPhases(setup, "complete");
});

test("manual persistence failure clears partial preview without persistence", async () => {
  const setup = runtime({
    compact: () => {
      throw new Error("Transaction failed");
    },
    model: {
      complete: () =>
        Promise.resolve(testCompactionTurn("Uncommitted summary")),
    },
  });

  await expect(compactSessionConversation(setup.value)).rejects.toThrow(
    "Transaction failed",
  );
  expectManualPhases(setup, "failure");
});
