import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { SessionForkInput } from "../shared/session-fork.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import type { SessionProviderUpdateInput } from "../shared/session-provider-update.ts";
import type {
  SessionToolUpdateInput,
  SessionToolUpdatePreview,
  SessionToolUpdatePreviewInput,
} from "../shared/session-tool-update.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type {
  AuthenticatedSessionAction,
  SessionDetailLookup,
} from "./session-command-types.ts";
import { startManualSessionCompaction } from "./session-compaction-actions.ts";
import { createSessionContextTokenCapAction } from "./session-context-limit-action.ts";
import { type SessionLaunchBoundary } from "./session-creation.ts";
import {
  readSessionCredential,
  type SessionCredentialSelection,
} from "./session-credential-access.ts";
import type { SessionCredentialOperation } from "./session-credential-operation.ts";
import type { SessionCredentialReaders } from "./session-credential-readers.ts";
import { requiredSessionDetail } from "./session-detail.ts";
import { readAuthorizedSessionHistory } from "./session-history.ts";
import type { CreateSessionInput, PromptInput } from "./session-input.ts";
import type { SessionPendingInputCommand } from "./session-pending-input-request.ts";
import { type CancelPendingInputResult } from "./session-pending-inputs.ts";
import type { SessionProviderUpdateDependencies } from "./session-provider-update.ts";
import {
  answerSessionQuestionsCommand,
  isQuestionActionFailure,
  type SessionQuestionActionDependencies,
} from "./session-question-actions.ts";
import {
  queueSessionForUser,
  type SessionQueueDependencies,
} from "./session-queue.ts";
import type {
  SessionAutoCompactionAction,
  SessionCancelPendingInputAction,
  SessionContextTokenCapAction,
  SessionCreateAction,
  SessionHistoryAction,
  SessionQuestionAnswerAction,
  SessionRealtimeCommands,
  SessionReassignmentAction,
  SessionStopAction,
} from "./session-realtime-commands.ts";
import { createSessionWithCredentialPool } from "./session-realtime-create.ts";
import { requireJsonResponse } from "./session-realtime-errors.ts";
import { forkSessionForUser } from "./session-realtime-fork.ts";
import { discoverSessionModelsFromPool } from "./session-realtime-models.ts";
import {
  applyResolvedSessionProviderUpdate,
  updateSessionProviderWithPool,
} from "./session-realtime-provider-update.ts";
import { stopSessionForUser } from "./session-realtime-stop.ts";
import {
  reassignSession,
  sessionReassignmentError,
} from "./session-reassignment-request.ts";
import type { SessionReassignmentInput } from "./session-reassignment.ts";
import type { SessionStore } from "./session-store.ts";
import {
  applySessionToolUpdate,
  isSessionToolUpdateError,
  previewSessionToolUpdate,
  type SessionToolUpdateDependencies,
} from "./session-tool-update.ts";

type RealtimeSessionCommandDependencies = SessionLaunchBoundary &
  Pick<SessionQueueDependencies, "runnerIsAvailable"> &
  Omit<RealtimeSessionCommandsOptions, "availability" | "lifecycle">;

interface RealtimeSessionCommandsOptions {
  readonly actions: SessionAgentActions;
  readonly database: SessionToolUpdateDependencies["store"]["database"];
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly lifecycle: SessionLaunchBoundary;
  readonly modelCredentialPool: ModelCredentialPool;
  readonly providers: SessionCredentialReaders;
  readonly providerUpdates: Omit<
    SessionProviderUpdateDependencies,
    "discoverModels" | "discoverOpenRouterProviders" | "providers" | "store"
  >;
  readonly questions: SessionQuestionActionDependencies;
  readonly restartSignal: () => AbortSignal;
  readonly toolUpdates: Omit<
    SessionToolUpdateDependencies,
    "readCredentialSource" | "store"
  >;
  readonly availability: Pick<SessionQueueDependencies, "runnerIsAvailable">;
  readonly store: SessionStore;
}

export type { RealtimeSessionCommandsOptions };

async function responseValue(response: Response): Promise<void> {
  return requireJsonResponse(response);
}

function cancellationError(
  status: "consumed" | "invalid_state" | "not_found",
): RealtimeCommandError {
  const code = {
    consumed: "pending_input_consumed",
    invalid_state: "invalid_session_state",
    not_found: "not_found",
  } as const;
  return new RealtimeCommandError(code[status]);
}

export function createRealtimeSessionCommandsIntegration(
  options: RealtimeSessionCommandsOptions,
): SessionRealtimeCommands {
  const dependencies: RealtimeSessionCommandDependencies = {
    ...options,
    ...options.availability,
    ...options.lifecycle,
  };
  const contextTokenCapAction = createSessionContextTokenCapAction({
    now: () => dependencies.now(),
    notify: dependencies.notify,
    store: dependencies.store,
  });

  async function credential(
    userId: string,
    selection: SessionCredentialSelection,
  ) {
    try {
      const credential = await readSessionCredential(
        dependencies.providers,
        userId,
        selection,
      );
      if (credential === undefined) {
        throw new RealtimeCommandError("credential_unavailable");
      }
      return credential;
    } catch (error) {
      if (error instanceof RealtimeCommandError) {
        throw error;
      }
      throw new RealtimeCommandError("credential_refresh_failed");
    }
  }

  const answerQuestionsForUser: SessionQuestionAnswerAction = async (
    user,
    payload,
  ) => {
    try {
      return await answerSessionQuestionsCommand(
        dependencies.questions,
        user,
        payload,
      );
    } catch (error) {
      if (isQuestionActionFailure(error)) {
        throw new RealtimeCommandError(error.code);
      }
      throw error;
    }
  };

  const cancelPendingInputForUser: SessionCancelPendingInputAction = (
    user,
    sessionId,
    inputId,
    workspaceId,
  ) => {
    const existing = detail(user.id, sessionId, workspaceId);
    const result: CancelPendingInputResult =
      dependencies.store.cancelPendingInput({
        inputId,
        now: dependencies.now(),
        sessionId,
        userId: user.id,
      });
    type Status = CancelPendingInputResult["status"];
    const handlers: Record<Status, () => CancelPendingInputResult> = {
      already_cancelled: () => result,
      cancelled: () => result,
      consumed: () => result,
      invalid_state: () => result,
      not_found: () => result,
    };
    const handled = handlers[result.status]();
    if (
      handled.status === "already_cancelled" ||
      handled.status === "cancelled"
    ) {
      const updatedDetail = detail(user.id, existing.id, workspaceId);
      dependencies.notify(user.id, sessionId);
      return { detail: updatedDetail, input: handled.input };
    }
    throw cancellationError(handled.status);
  };

  function compactForUser(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string,
    operation: Extract<
      RestartHandoffOperation,
      "compact" | "compact_and_continue"
    > = "compact",
  ): Promise<AgentSessionDetail> {
    return withOwnedDetail(user, sessionId, workspaceId, async () => {
      const response = await startManualSessionCompaction(
        {
          credential: credentialAction(),
          launch: dependencies.launch,
          notify: dependencies.notify,
          now: dependencies.now,
          operation,
          runtimes: dependencies.runtimes,
          store: dependencies.store,
        },
        user,
        sessionId,
      );
      return detailFromResponse(user.id, sessionId, response);
    });
  }

  const compactAndContinueForUser: AuthenticatedSessionAction = (
    ...arguments_
  ) => compactForUser(...arguments_, "compact_and_continue");

  function continueForUser(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId?: string,
  ): Promise<AgentSessionDetail> {
    return queueOwned({
      sessionId,
      user,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
  }

  async function createSession(
    user: AuthenticatedUser,
    input: CreateSessionInput & { readonly parentUserInitiated?: boolean },
    workspaceId: string,
  ): Promise<AgentSessionDetail> {
    return createSessionWithCredentialPool({
      dependencies: {
        ...dependencies,
        readCredential: (userId, selection) => credential(userId, selection),
      },
      input,
      user,
      workspaceId,
    });
  }

  const createForUser: SessionCreateAction = (user, input, workspaceId) =>
    createSession(user, input, workspaceId);

  const spawnForUser: SessionRealtimeCommands["spawnForUser"] = async (
    user,
    input,
    workspaceId,
  ) => {
    const parent = dependencies.store.get(
      user.id,
      input.parentSessionId,
      workspaceId,
    );
    if (
      parent?.generation !== input.parentGeneration ||
      parent.runnerRequired
    ) {
      throw new RealtimeCommandError("parent_stale");
    }
    return createSession(
      user,
      { ...input, parentUserInitiated: true },
      workspaceId,
    );
  };

  const forkForUser: SessionRealtimeCommands["forkForUser"] = async (
    user: AuthenticatedUser,
    input: SessionForkInput,
    workspaceId: string,
  ): Promise<AgentSessionDetail> => {
    if (input.workspaceId !== workspaceId) {
      throw new RealtimeCommandError("not_found");
    }
    const source = detail(user.id, input.sourceSessionId, workspaceId);
    return forkSessionForUser({
      compact: (sessionId) => compactForUser(user, sessionId, workspaceId),
      dependencies: {
        credential: (userId, selection) => credential(userId, selection),
        discoverModels: dependencies.discoverModels,
        discoverOpenRouterProviders: dependencies.discoverOpenRouterProviders,
        modelCredentialPool: dependencies.modelCredentialPool,
        notify: dependencies.notify,
        now: dependencies.now,
        restartSignal: dependencies.restartSignal,
        store: dependencies.store,
      },
      input,
      source,
      user,
    });
  };

  async function messageForUser(
    user: AuthenticatedUser,
    sessionId: string,
    input: PromptInput,
    workspaceId: string,
  ): Promise<AgentSessionDetail> {
    return queueOwned({ input, sessionId, user, workspaceId });
  }

  function pendingInputForUser(
    user: AuthenticatedUser,
    input: SessionPendingInputCommand,
    workspaceId: string,
  ): AgentSessionDetail {
    const owned = dependencies.store.get(user.id, input.sessionId, workspaceId);
    if (owned === undefined) {
      throw new RealtimeCommandError("not_found");
    }
    const attachments = input.attachments ?? input.images;
    const result = dependencies.store.enqueuePendingInput(
      user.id,
      input.sessionId,
      {
        clientRequestId: input.clientRequestId,
        content: input.prompt,
        images: attachments,
        kind: input.kind,
      },
      dependencies.now(),
    );
    const currentDetail = () => detail(user.id, input.sessionId, workspaceId);
    const handlers: Record<typeof result.status, () => AgentSessionDetail> = {
      accepted: () => {
        dependencies.notify(user.id, input.sessionId);
        return currentDetail();
      },
      duplicate: currentDetail,
      conflict: () => {
        throw new RealtimeCommandError("pending_input_id_conflict");
      },
      invalid_state: () => {
        throw new RealtimeCommandError("invalid_session_state");
      },
      not_found: () => {
        throw new RealtimeCommandError("not_found");
      },
    };
    return handlers[result.status]();
  }

  async function modelsForUser(selection: {
    readonly credentialId: string;
    readonly provider: ProviderId;
    readonly user: AuthenticatedUser;
    readonly workspaceId: string;
  }): Promise<AgentModelCatalog> {
    return discoverSessionModelsFromPool({
      discover: dependencies.discoverModels,
      pool: dependencies.modelCredentialPool,
      selection: { ...selection, userId: selection.user.id },
      signal: dependencies.restartSignal(),
    });
  }

  async function previewToolUpdateForUser(
    user: AuthenticatedUser,
    input: SessionToolUpdatePreviewInput,
  ): Promise<SessionToolUpdatePreview> {
    return runToolUpdate(() =>
      previewSessionToolUpdate(toolUpdateDependencies(), user.id, input),
    );
  }

  const detailForUser: SessionDetailLookup = (...parameters) =>
    dependencies.store.get(...parameters);

  const historyForUser: SessionHistoryAction = (
    user,
    sessionId,
    cursor,
    workspaceId,
  ) => {
    return readAuthorizedSessionHistory(dependencies.store, user, {
      cursor,
      sessionId,
      workspaceId,
    });
  };

  const reassignForUser: SessionReassignmentAction = (
    user,
    sessionId,
    runnerId,
    workingDirectory,
    workspaceId,
  ) => {
    const change = () => {
      const input: SessionReassignmentInput = { runnerId, workingDirectory };
      const result = reassignSession(dependencies, user.id, sessionId, input);
      if (result.status !== "reassigned") {
        throw new RealtimeCommandError(sessionReassignmentError(result));
      }
      dependencies.notify(user.id, sessionId);
      return result.detail;
    };
    return withOwnedDetail(user, sessionId, workspaceId, change);
  };

  const setAutoCompactionForUser: SessionAutoCompactionAction = (
    ...parameters
  ) => setCompactionFlag("setAutoCompact", ...parameters);

  const setIdleCompactionForUser: SessionAutoCompactionAction = (
    ...parameters
  ) => setCompactionFlag("setIdleCompact", ...parameters);

  function setCompactionFlag(
    setter: "setAutoCompact" | "setIdleCompact",
    ...[
      user,
      sessionId,
      enabled,
      workspaceId,
    ]: Parameters<SessionAutoCompactionAction>
  ): ReturnType<SessionAutoCompactionAction> {
    return withOwnedDetail(user, sessionId, workspaceId, () => {
      const detail = dependencies.store[setter](
        user.id,
        sessionId,
        enabled,
        dependencies.now(),
        workspaceId,
      );
      if (detail === undefined) {
        throw new RealtimeCommandError("not_found");
      }
      dependencies.notify(user.id, sessionId);
      return detail;
    });
  }

  function setContextTokenCapForUser(
    ...parameters: Parameters<SessionContextTokenCapAction>
  ) {
    return contextTokenCapAction(...parameters);
  }

  const stopForUser: SessionStopAction = async (
    user,
    sessionId,
    cascade,
    workspaceId,
  ) =>
    stopSessionForUser({
      cascade,
      dependencies: dependencies,
      sessionId,
      user,
      workspaceId,
    });

  function summariesForUser(userId: string, workspaceId: string) {
    return dependencies.store.list(userId, workspaceId);
  }

  function providerUpdateStoreAccess() {
    return {
      resources: dependencies.store.writeResources(),
    };
  }

  async function updateProviderForUser(
    user: AuthenticatedUser,
    input: SessionProviderUpdateInput,
  ): Promise<AgentSessionDetail> {
    return updateSessionProviderWithPool({
      dependencies: {
        apply: (userId, resolved, rejectCredentialErrors) =>
          applyProviderUpdate(userId, resolved, rejectCredentialErrors),
        pool: dependencies.modelCredentialPool,
      },
      input,
      user,
    });
  }

  async function applyProviderUpdate(
    userId: string,
    input: SessionProviderUpdateInput,
    rejectCredentialErrors: boolean,
  ): Promise<AgentSessionDetail> {
    const outcome = await applyResolvedSessionProviderUpdate({
      dependencies: {
        ...dependencies.providerUpdates,
        discoverModels: dependencies.discoverModels,
        discoverOpenRouterProviders: dependencies.discoverOpenRouterProviders,
        providers: dependencies.providers,
        rejectCredentialErrors,
        restartSignal: dependencies.restartSignal,
      },
      input,
      store: providerUpdateStoreAccess(),
      userId,
    });
    return notifyUpdatedSession(userId, input.sessionId, outcome);
  }

  async function updateToolsForUser(
    user: AuthenticatedUser,
    input: SessionToolUpdateInput,
  ): Promise<AgentSessionDetail> {
    const applied = await runToolUpdate(() =>
      applySessionToolUpdate(toolUpdateDependencies(), user.id, input),
    );
    return notifyUpdatedSession(user.id, input.sessionId, applied);
  }

  function notifyUpdatedSession(
    ...parameters: [string, string, AgentSessionDetail]
  ) {
    dependencies.notify(parameters[0], parameters[1]);
    return parameters[2];
  }

  function withOwnedDetail<Value>(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string | undefined,
    action: (detail: AgentSessionDetail) => Value,
  ) {
    return action(detail(user.id, sessionId, workspaceId));
  }

  async function runToolUpdate<Value>(
    action: () => Promise<Value>,
  ): Promise<Value> {
    try {
      return await action();
    } catch (error) {
      throw toolUpdateError(error);
    }
  }

  function toolUpdateDependencies(): SessionToolUpdateDependencies {
    return {
      ...dependencies.toolUpdates,
      readCredentialSource: async (userId, detail) =>
        (await credential(userId, detail)).source,
      store: dependencies.store.writeResources(),
    };
  }

  function toolUpdateError(error: unknown): RealtimeCommandError {
    return new RealtimeCommandError(
      isSessionToolUpdateError(error) ? error.code : "command_failed",
    );
  }

  async function queueOwned(options: {
    readonly input?: PromptInput;
    readonly sessionId: string;
    readonly user: AuthenticatedUser;
    readonly workspaceId?: string;
  }): Promise<AgentSessionDetail> {
    detail(options.user.id, options.sessionId, options.workspaceId);
    return queue(
      options.user,
      options.sessionId,
      options.input,
      options.workspaceId,
    );
  }

  async function queue(
    user: AuthenticatedUser,
    sessionId: string,
    prompt?: PromptInput,
    workspaceId?: string,
  ): Promise<AgentSessionDetail> {
    const response = await queueSessionForUser(
      {
        ...dependencies,
        credential: credentialAction(),
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
      user.id,
      sessionId,
      prompt,
    );
    return detailFromResponse(user.id, sessionId, response);
  }

  function credentialAction(): SessionCredentialOperation {
    return async (userId, detail, action) =>
      action(await credential(userId, detail));
  }

  async function detailFromResponse(
    userId: string,
    sessionId: string,
    response: Response,
  ): Promise<AgentSessionDetail> {
    await responseValue(response);
    return detail(userId, sessionId);
  }

  function detail(
    userId: string,
    sessionId: string,
    workspaceId?: string,
  ): AgentSessionDetail {
    return requiredSessionDetail(
      dependencies.store.get.bind(dependencies.store),
      [userId, sessionId, workspaceId],
      () => new RealtimeCommandError("not_found"),
    );
  }
  return {
    answerQuestionsForUser,
    cancelPendingInputForUser,
    compactForUser,
    compactAndContinueForUser,
    continueForUser,
    createForUser,
    spawnForUser,
    forkForUser,
    historyForUser,
    messageForUser,
    pendingInputForUser,
    modelsForUser,
    previewToolUpdateForUser,
    detailForUser,
    reassignForUser,
    setAutoCompactionForUser,
    setIdleCompactionForUser,
    setContextTokenCapForUser,
    stopForUser,
    summariesForUser,
    updateProviderForUser,
    updateToolsForUser,
  };
}
