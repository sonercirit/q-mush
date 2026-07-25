import { expect } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import type { AgentModelTurn } from "../../shared/agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import { connectedSessionSetup } from "./session-integration-fixtures.ts";
import {
  sessionDetail,
  startSessionAndCompleteAgentFile,
} from "./session-integration-helpers.ts";
import {
  assignedRunnerRemoval,
  stopSessionRequest,
} from "./session-reassignment-test-helpers.ts";

const MODEL_ID = "gpt-4.1-mini";

export type ContinuationSetup = ReturnType<typeof connectedSessionSetup>;

function compactionCatalog(label: string): AgentModelCatalog {
  return {
    defaultModel: MODEL_ID,
    models: [
      {
        contextWindow: 100_000,
        id: MODEL_ID,
        inputModalities: null,
        label,
        outputModalities: null,
        pricing: null,
        reasoningEfforts: ["high"],
      },
    ],
  };
}

export function compactionTurn(
  content: string,
  options: {
    readonly contextTokens?: number;
    readonly costUsd?: number;
  } = {},
): Omit<
  AgentModelTurn,
  "contextTokens" | "costUsd" | "thinking" | "tokenUsage"
> & {
  readonly contextTokens?: number;
  readonly costUsd?: number;
} {
  return { content, toolCalls: [], ...options };
}

export function continuationSetup(
  turns: ConstructorParameters<typeof ScriptedAgentModel>[0],
  options: {
    readonly blockRequest?: number;
    readonly label: string;
    readonly notifyRequest?: number;
  },
) {
  const blocked = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const notified = Promise.withResolvers<undefined>();
  const model = new ScriptedAgentModel(turns, {
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
): Promise<unknown> {
  await startCompactingSession(continuation);
  await continuation.notified;
  return drainAndRead(continuation.setup);
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
