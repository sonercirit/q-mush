import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import { isAskQuestionsPause } from "./ask-questions-pause.ts";
import { isDiskFullFailure } from "./database-write-resilience.ts";
import {
  compactSessionConversation,
  isRestartHandoffError,
  runSessionAgent,
} from "./session-agent-runtime.ts";
import type { SessionNotification } from "./session-creation.ts";
import { currentStoredSession } from "./session-current.ts";
import type { FinishSession } from "./session-launcher.ts";
import {
  sessionModelRuntime,
  type SessionModelRuntimeResources,
} from "./session-model-runtime.ts";
import type {
  DurableRestartPersistence,
  SessionRestartRequester,
} from "./session-restart-requester.ts";
import type { RestartHandoffIdentity } from "./session-restart-store.ts";
import type { RestartRequest } from "./session-runtime.ts";
import { sessionHasStatus } from "./session-status.ts";
import type { SessionStore } from "./session-store.ts";

interface RunPersistedSessionOptions extends SessionRestartRequester {
  readonly controller: AbortController;
  readonly credential: ProviderCredentialAccess;
  readonly detail: AgentSessionDetail;
  readonly finish: FinishSession;
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly operation: RestartHandoffOperation;
  readonly resources: SessionModelRuntimeResources;
  readonly restartPersistence: DurableRestartPersistence;
  readonly store: SessionStore;
  readonly userId: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function identity(
  detail: AgentSessionDetail,
): RestartHandoffIdentity | undefined {
  const handoff = detail.restartHandoff;
  return handoff === null
    ? undefined
    : {
        generation: handoff.executionGeneration,
        restartId: handoff.restartId,
        sessionId: detail.id,
      };
}

function persistedRestartRequest(request: RestartRequest): RestartRequest {
  return request.boundary === "step"
    ? { ...request, boundary: "handoff" }
    : request;
}

function pauseForRestart(
  options: RunPersistedSessionOptions,
  request: RestartRequest,
): boolean {
  const handoff = persistedRestartRequest(request);
  return options.store.pauseRunningForRestart(
    { generation: options.detail.generation, sessionId: options.detail.id },
    handoff.requestedBy,
    handoff.restartId,
    options.operation,
    options.now(),
  );
}

type HandoffPersistence =
  | { readonly status: "already_persisted" | "persisted" }
  | { readonly error: Error; readonly status: "failed" };

function failedHandoffPersistence(
  request: RestartRequest | undefined,
): HandoffPersistence {
  return {
    error:
      request === undefined
        ? new Error("The restart handoff request was lost")
        : new Error("The restart handoff could not be persisted"),
    status: "failed",
  };
}

function persistRestartHandoff(
  options: RunPersistedSessionOptions,
  acceptExistingHandoff: boolean,
): HandoffPersistence {
  const request = options.restartRequest();
  if (request === undefined && !acceptExistingHandoff) {
    return failedHandoffPersistence(request);
  }
  if (request !== undefined && pauseForRestart(options, request)) {
    return { status: "persisted" };
  }
  const current = currentStoredSession(
    options.store,
    options.userId,
    options.detail,
  );
  if (
    sessionHasStatus(current, "stopped") ||
    (acceptExistingHandoff &&
      current?.status === "paused" &&
      current.restartHandoff !== null)
  ) {
    return { status: "already_persisted" };
  }
  return failedHandoffPersistence(request);
}

function currentSessionIsIdle(
  options: RunPersistedSessionOptions,
): AgentSessionDetail | undefined {
  const current = currentStoredSession(
    options.store,
    options.userId,
    options.detail,
  );
  return current?.status === "idle" && current.restartHandoff === null
    ? current
    : undefined;
}

function finishRecoveredSession(
  options: RunPersistedSessionOptions,
  claimedIdentity: RestartHandoffIdentity | undefined,
): void {
  const current = currentSessionIsIdle(options);
  if (current !== undefined) {
    options.finish(current, options.userId);
    return;
  }
  options.finish(options.detail, options.userId, undefined, claimedIdentity);
}

function finishFailedSession(
  options: RunPersistedSessionOptions,
  error: unknown,
  claimedIdentity: RestartHandoffIdentity | undefined,
): void {
  options.finish(options.detail, options.userId, error, claimedIdentity);
}

function persistHandoffOutcome(options: RunPersistedSessionOptions): void {
  const persistence = persistRestartHandoff(options, false);
  if (persistence.status === "failed") {
    throw persistence.error;
  }
  options.notify(options.userId, options.detail.id);
}

export async function runPersistedSession(
  options: RunPersistedSessionOptions,
): Promise<void> {
  const claimedIdentity = identity(options.detail);

  try {
    if (
      !options.store.transitionRuntime(
        options.detail.id,
        "running",
        options.now(),
        options.detail.generation,
      )
    ) {
      return;
    }
    options.restartRequest(options.restartPersistence.persist);
    options.notify(options.userId, options.detail.id);

    const runtime = sessionModelRuntime(
      options.resources,
      options.detail,
      options.credential,
      options.userId,
      options.controller,
      () => options.restartRequest() !== undefined,
    );
    const manualCompaction = options.operation !== "agent";
    const outcome = await (manualCompaction
      ? compactSessionConversation(
          runtime,
          options.operation === "compact_and_continue",
        )
      : runSessionAgent(runtime));
    if (
      options.operation === "compact_and_continue" &&
      outcome === "complete"
    ) {
      const continued = await runSessionAgent(runtime);
      if (continued === "handoff") {
        persistHandoffOutcome(options);
        return;
      }
      finishRecoveredSession(options, claimedIdentity);
      return;
    }
    if (options.operation === "compact" && outcome === "complete") {
      finishRecoveredSession(options, claimedIdentity);
      return;
    }
    if (outcome === "handoff") {
      persistHandoffOutcome(options);
      return;
    }
    finishRecoveredSession(options, claimedIdentity);
  } catch (error) {
    let terminal: AgentSessionDetail | undefined;
    try {
      terminal = currentSessionIsIdle(options);
    } catch (readError) {
      if (isDiskFullFailure(error) && isDiskFullFailure(readError)) {
        finishFailedSession(options, error, claimedIdentity);
        return;
      }
      throw readError;
    }
    if (terminal !== undefined) {
      options.finish(terminal, options.userId);
      return;
    }
    if (isRestartHandoffError(error)) {
      const persistence = persistRestartHandoff(options, true);
      if (persistence.status === "persisted") {
        options.notify(options.userId, options.detail.id);
      } else if (persistence.status === "failed") {
        finishFailedSession(options, persistence.error, claimedIdentity);
      }
      return;
    }
    if (isAskQuestionsPause(error)) {
      finishFailedSession(options, error, claimedIdentity);
      return;
    }

    if (!options.controller.signal.aborted && !isAbort(error)) {
      finishFailedSession(options, error, claimedIdentity);
    }
  }
}
