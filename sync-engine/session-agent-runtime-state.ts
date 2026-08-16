import { RunnerDisconnectedError } from "../shared/runner-disconnected-error.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";
import type { SessionAgentRuntimeDependencies } from "./session-agent-runtime.ts";
import type { CompactionUsage } from "./session-compaction-usage.ts";
import type { SessionStore } from "./session-store.ts";

export function writeRuntime(
  runtime: SessionAgentRuntimeDependencies,
  write: (sessionId: string, now: number, generation: number) => void,
): void {
  write(runtime.detail.id, runtime.now(), runtime.detail.generation);
  runtime.notify();
}

export function markSessionStepStart(
  runtime: SessionAgentRuntimeDependencies,
): void {
  // Status- and generation-guarded: a racing stop or restart makes this
  // write match zero rows instead of throwing.
  const { store } = runtime;
  writeRuntime(runtime, store.markRuntimeStepStart.bind(store));
}

export function recordRuntimeUsage(
  runtime: SessionAgentRuntimeDependencies,
  usage: AgentSessionUsageUpdate,
): void {
  writeRuntime(runtime, (sessionId, now, generation) => {
    runtime.store.updateRuntimeUsage(sessionId, usage, now, generation);
  });
}

function recordCompactionContext(
  runtime: SessionAgentRuntimeDependencies,
  contextTokens: number | null,
): void {
  if (contextTokens !== null) {
    recordRuntimeUsage(runtime, {
      contextTokens,
      costBasis: null,
      costUsd: null,
    });
  }
}

export function recordCompaction(
  runtime: SessionAgentRuntimeDependencies,
  summary: string,
  usage: CompactionUsage,
  startedAt: number,
  terminal = false,
): void {
  recordCompactionContext(runtime, usage.contextTokens);
  writeRuntime(runtime, (sessionId, now, generation) => {
    if (terminal) {
      runtime.store.compactRuntimeTerminal(
        sessionId,
        summary,
        usage,
        now,
        generation,
        startedAt,
        runtime.detail.restartHandoff,
      );
      return;
    }
    runtime.store.compactRuntimeConversation(
      sessionId,
      summary,
      usage,
      now,
      generation,
      startedAt,
    );
  });
}

function isSessionRestartHandoff(
  runtime: SessionAgentRuntimeDependencies,
  error: unknown,
): boolean {
  return (
    runtime.restartHandoffRequested() &&
    ((error instanceof DOMException && error.name === "AbortError") ||
      error instanceof RunnerDisconnectedError)
  );
}

function restartHandoffError(): DOMException {
  return new DOMException(
    "The runner disconnected during a restart handoff",
    "RestartHandoff",
  );
}

export async function executeForSession<Result>(
  runtime: SessionAgentRuntimeDependencies,
  execute: () => Promise<Result>,
  handoff?: (error: DOMException) => void,
): Promise<Result> {
  try {
    return await execute();
  } catch (error) {
    if (isSessionRestartHandoff(runtime, error)) {
      const handoffError = restartHandoffError();
      handoff?.(handoffError);
      throw handoffError;
    }
    throw error;
  }
}

export function throwIfRestartRequested(
  runtime: SessionAgentRuntimeDependencies,
): void {
  if (runtime.restartHandoffRequested()) {
    throw new DOMException(
      "The restart began before an auxiliary model request",
      "RestartHandoff",
    );
  }
}

export function isRestartHandoffError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "RestartHandoff";
}

export function sessionConversation(
  runtime: SessionAgentRuntimeDependencies,
): ReturnType<SessionStore["conversation"]> {
  return runtime.store.conversation(
    runtime.detail.id,
    runtime.detail.restartHandoff === null,
  );
}
