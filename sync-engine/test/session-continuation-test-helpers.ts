import { expect } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import type { AgentModelStep } from "../../shared/agent-loop.ts";
import {
  type ScriptedStep,
  createScriptedAgentModel,
} from "./scripted-agent-model.ts";
import { connectedSessionSetup } from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  sessionDetail,
  startSessionAndCompleteAgentFile,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import {
  assignedRunnerRemoval,
  stopSessionRequest,
} from "./session-reassignment-test-helpers.ts";

const MODEL_ID = "gpt-4.1-mini";

export type ContinuationSetup = ReturnType<typeof connectedSessionSetup>;

export function testModelCatalog(
  modelId: string,
  label: string,
): AgentModelCatalog {
  return {
    defaultModel: modelId,
    models: [
      {
        adaptiveThinking: null,
        contextWindow: 100_000,
        id: modelId,
        inputModalities: null,
        label,
        maxOutputTokens: null,
        outputModalities: null,
        pricing: null,
        reasoningEfforts: ["high"],
      },
    ],
  };
}

function compactionCatalog(label: string): AgentModelCatalog {
  return testModelCatalog(MODEL_ID, label);
}

export function compactionStep(
  content: string,
  options: {
    readonly contextTokens?: number;
    readonly costUsd?: number;
  } = {},
): Omit<
  AgentModelStep,
  "contextTokens" | "costUsd" | "thinking" | "tokenUsage"
> & {
  readonly contextTokens?: number;
  readonly costUsd?: number;
} {
  return { content, toolCalls: [], ...options };
}

export function continuationSetup(
  steps: ScriptedStep[],
  options: {
    readonly blockRequest?: number;
    readonly label: string;
    readonly notifyRequest?: number;
  },
) {
  const blocked = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const notified = Promise.withResolvers<undefined>();
  const model = createScriptedAgentModel(steps, {
    onComplete: async (requestCount) => {
      if (requestCount === options.notifyRequest) {
        notified.resolve(undefined);
      }
      if (requestCount === options.blockRequest) {
        entered.resolve(undefined);
        await blocked.promise;
      }
    },
  });
  return {
    blocked,
    entered: entered.promise,
    model,
    notified: notified.promise,
    setup: connectedSessionSetup(model, "api_key", () =>
      Promise.resolve(compactionCatalog(options.label)),
    ),
  };
}

export function expectContinuationRequests(
  continuation: ReturnType<typeof continuationSetup>,
  handoff: string,
): void {
  expect(continuation.model.requests).toHaveLength(3);
  expect(continuation.model.requests[2]?.[0]?.content).toContain(handoff);
}

export async function startCompactingSession(
  continuation: ReturnType<typeof continuationSetup>,
): Promise<void> {
  await startSessionAndCompleteAgentFile(continuation.setup);
}

export async function drainAndRead(setup: ContinuationSetup): Promise<unknown> {
  await setup.sessions.drain();
  return sessionDetail(setup.sessions);
}

export async function startAndAwaitContinuation(
  continuation: ReturnType<typeof continuationSetup>,
  status: "failed" | "idle",
): Promise<unknown> {
  await startCompactingSession(continuation);
  await continuation.notified;
  return waitForSessionValue(
    () => sessionDetail(continuation.setup.sessions),
    hasSessionStatus(status),
  );
}

export async function stopContinuationSession(
  continuation: ReturnType<typeof continuationSetup>,
): Promise<unknown> {
  const stopped = await stopSessionRequest(continuation.setup);
  return stopped.json();
}

export async function removeContinuationRunner(
  setup: ContinuationSetup,
): Promise<Response> {
  const removed = await assignedRunnerRemoval(setup);
  expect(removed.status).toBe(204);
  return removed;
}

export function expectTranscriptContent(
  detail: unknown,
  content: string,
  present: boolean,
): void {
  const serialized = JSON.stringify(detail);
  if (present) {
    expect(serialized).toContain(content);
  } else {
    expect(serialized).not.toContain(content);
  }
}

export function closeContinuationSetup(setup: ContinuationSetup): void {
  setup.database.$client.close();
}
