import { expect, test } from "vitest";
import type { AgentConversationCompaction } from "../../sync-engine/agent-compaction.ts";
import { runCompactingAgentLoop } from "../../sync-engine/session-agent-loop.ts";
import {
  automaticCompactionOptions,
  testCompaction,
} from "./compaction-loop-test-helpers.ts";
import { testCompactedConversation } from "./compaction-test-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

function deferredCompaction() {
  let resolve:
    | ((
        value: Awaited<ReturnType<AgentConversationCompaction["compact"]>>,
      ) => void)
    | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const result = new Promise<
    Awaited<ReturnType<AgentConversationCompaction["compact"]>>
  >((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (resolve === undefined || reject === undefined) {
    throw new Error("The compaction promise was not initialized");
  }
  return { reject, resolve, result };
}

function automaticModel(): ScriptedAgentModel {
  return new ScriptedAgentModel([
    { content: "Done", contextTokens: 95, toolCalls: [] },
    { content: "Continued", contextTokens: 1, toolCalls: [] },
  ]);
}

function testAutomaticRun(options: {
  readonly createCompactor: Parameters<
    typeof automaticCompactionOptions
  >[0]["createCompactor"];
  readonly phases: string[];
  readonly recordCompaction: () => void;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const base = {
    createCompactor: options.createCompactor,
    model: automaticModel(),
    recordCompaction: options.recordCompaction,
  };
  return runCompactingAgentLoop(
    automaticCompactionOptions(
      options.signal === undefined ? base : { ...base, signal: options.signal },
    ),
  );
}

test("automatic pre-request compaction completes only after persistence", async () => {
  const pending = deferredCompaction();
  const phases: string[] = [];
  let persisted = false;
  const run = runCompactingAgentLoop(
    automaticCompactionOptions({
      createCompactor: () => {
        const compaction = testCompaction(() => pending.result, phases);
        return {
          ...compaction,
          complete: () => {
            compaction.complete();
            expect(persisted).toBe(true);
          },
        };
      },
      executeTool: () => Promise.resolve("tool output"),
      model: new ScriptedAgentModel([
        {
          content: "Use a tool",
          contextTokens: 95,
          toolCalls: [{ arguments: "{}", id: "call-1", name: "read" }],
        },
        { content: "Done", contextTokens: 1, toolCalls: [] },
      ]),
      recordCompaction: () => {
        persisted = true;
      },
    }),
  );

  pending.resolve(testCompactedConversation("handoff"));
  await run;
  expect(phases).toEqual(["complete"]);
});

test("automatic final compaction fails terminally when persistence fails", async () => {
  const phases: string[] = [];
  const failure = "Persistence failed";
  const run = testAutomaticRun({
    createCompactor: () =>
      testCompaction(
        () => Promise.resolve(testCompactedConversation("final handoff")),
        phases,
      ),
    phases,
    recordCompaction: () => {
      throw new Error(failure);
    },
  });

  await expect(run).rejects.toThrow(failure);
  expect(phases).toEqual(["failure"]);
});

test("automatic compaction cancellation emits one cancel-like terminal callback", async () => {
  const controller = new AbortController();
  const phases: string[] = [];
  const run = testAutomaticRun({
    createCompactor: () =>
      testCompaction(() => {
        controller.abort("compaction stopped");
        return Promise.reject(new DOMException("Stopped", "AbortError"));
      }, phases),
    phases,
    recordCompaction: () => undefined,
    signal: controller.signal,
  });

  await expect(run).rejects.toThrow("Stopped");
  expect(phases).toEqual(["cancel"]);
});
