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
  previewSessionToolUpdate,
  SessionToolUpdateError,
  type SessionToolUpdateDependencies,
} from "./session-tool-update.ts";

export type RealtimeSessionCommandDependencies = SessionLaunchBoundary &
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

export class RealtimeSessionCommands implements SessionRealtimeCommands {
  readonly #contextTokenCapAction: SessionContextTokenCapAction;
  readonly #dependencies: RealtimeSessionCommandDependencies;

  constructor(options: RealtimeSessionCommandsOptions) {
    this.#dependencies = {
      ...options,
      ...options.availability,
      ...options.lifecycle,
    };
    this.#contextTokenCapAction = createSessionContextTokenCapAction({
      now: () => this.#dependencies.now(),
      notify: this.#dependencies.notify,
      store: this.#dependencies.store,
    });
  }

  async #credential(userId: string, selection: SessionCredentialSelection) {
    try {
      const credential = await readSessionCredential(
        this.#dependencies.providers,
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

  answerQuestionsForUser: SessionQuestionAnswerAction = async (
    user,
    payload,
  ) => {
    try {
      return await answerSessionQuestionsCommand(
        this.#dependencies.questions,
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

  cancelPendingInputForUser: SessionCancelPendingInputAction = (
    user,
    sessionId,
    inputId,
    workspaceId,
  ) => {
    const existing = this.#detail(user.id, sessionId, workspaceId);
    const result: CancelPendingInputResult =
      this.#dependencies.store.cancelPendingInput({
        inputId,
        now: this.#dependencies.now(),
        sessionId,
        userId: user.id,
      });
    switch (result.status) {
      case "already_cancelled":
      case "cancelled": {
        const detail = this.#detail(user.id, existing.id, workspaceId);
        this.#dependencies.notify(user.id, sessionId);
        return { detail, input: result.input };
      }
      case "consumed":
      case "invalid_state":
      case "not_found":
        throw cancellationError(result.status);
    }
  };

  compactForUser(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string,
    operation: Extract<
      RestartHandoffOperation,
      "compact" | "compact_and_continue"
    > = "compact",
  ): Promise<AgentSessionDetail> {
    return this.#withOwnedDetail(user, sessionId, workspaceId, async () => {
      const response = await startManualSessionCompaction(
        {
          credential: this.#credentialAction(),
          launch: this.#dependencies.launch,
          notify: this.#dependencies.notify,
          now: this.#dependencies.now,
          operation,
          runtimes: this.#dependencies.runtimes,
          store: this.#dependencies.store,
        },
        user,
        sessionId,
      );
      return this.#detailFromResponse(user.id, sessionId, response);
    });
  }

  compactAndContinueForUser: AuthenticatedSessionAction = (...arguments_) =>
    this.compactForUser(...arguments_, "compact_and_continue");

  continueForUser(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId?: string,
  ): Promise<AgentSessionDetail> {
    return this.#queueOwned({
      sessionId,
      user,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
  }

  async #createSession(
    user: AuthenticatedUser,
    input: CreateSessionInput & { readonly parentUserInitiated?: boolean },
    workspaceId: string,
  ): Promise<AgentSessionDetail> {
    return createSessionWithCredentialPool({
      dependencies: {
        ...this.#dependencies,
        readCredential: (userId, selection) =>
          this.#credential(userId, selection),
      },
      input,
      user,
      workspaceId,
    });
  }

  createForUser: SessionCreateAction = (user, input, workspaceId) =>
    this.#createSession(user, input, workspaceId);

  spawnForUser: SessionRealtimeCommands["spawnForUser"] = async (
    user,
    input,
    workspaceId,
  ) => {
    const parent = this.#dependencies.store.get(
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
    return this.#createSession(
      user,
      { ...input, parentUserInitiated: true },
      workspaceId,
    );
  };

  forkForUser = async (
    user: AuthenticatedUser,
    input: SessionForkInput,
    workspaceId: string,
  ): Promise<AgentSessionDetail> => {
    if (input.workspaceId !== workspaceId) {
      throw new RealtimeCommandError("not_found");
    }
    const source = this.#detail(user.id, input.sourceSessionId, workspaceId);
    return forkSessionForUser({
      compact: (sessionId) => this.compactForUser(user, sessionId, workspaceId),
      dependencies: {
        credential: (userId, selection) => this.#credential(userId, selection),
        discoverModels: this.#dependencies.discoverModels,
        discoverOpenRouterProviders:
          this.#dependencies.discoverOpenRouterProviders,
        modelCredentialPool: this.#dependencies.modelCredentialPool,
        notify: this.#dependencies.notify,
        now: this.#dependencies.now,
        restartSignal: this.#dependencies.restartSignal,
        store: this.#dependencies.store,
      },
      input,
      source,
      user,
    });
  };

  async messageForUser(
    user: AuthenticatedUser,
    sessionId: string,
    input: PromptInput,
    workspaceId: string,
  ): Promise<AgentSessionDetail> {
    return this.#queueOwned({ input, sessionId, user, workspaceId });
  }

  pendingInputForUser(
    user: AuthenticatedUser,
    input: SessionPendingInputCommand,
    workspaceId: string,
  ): AgentSessionDetail {
    const owned = this.#dependencies.store.get(
      user.id,
      input.sessionId,
      workspaceId,
    );
    if (owned === undefined) {
      throw new RealtimeCommandError("not_found");
    }
    const attachments = input.attachments ?? input.images;
    const result = this.#dependencies.store.enqueuePendingInput(
      user.id,
      input.sessionId,
      {
        clientRequestId: input.clientRequestId,
        content: input.prompt,
        images: attachments,
        kind: input.kind,
      },
      this.#dependencies.now(),
    );
    switch (result.status) {
      case "accepted":
        this.#dependencies.notify(user.id, input.sessionId);
        return this.#detail(user.id, input.sessionId, workspaceId);
      case "duplicate":
        return this.#detail(user.id, input.sessionId, workspaceId);
      case "conflict":
        throw new RealtimeCommandError("pending_input_id_conflict");
      case "invalid_state":
        throw new RealtimeCommandError("invalid_session_state");
      case "not_found":
        throw new RealtimeCommandError("not_found");
    }
  }

  async modelsForUser(selection: {
    readonly credentialId: string;
    readonly provider: ProviderId;
    readonly user: AuthenticatedUser;
    readonly workspaceId: string;
  }): Promise<AgentModelCatalog> {
    return discoverSessionModelsFromPool({
      discover: this.#dependencies.discoverModels,
      pool: this.#dependencies.modelCredentialPool,
      selection: { ...selection, userId: selection.user.id },
      signal: this.#dependencies.restartSignal(),
    });
  }

  async previewToolUpdateForUser(
    user: AuthenticatedUser,
    input: SessionToolUpdatePreviewInput,
  ): Promise<SessionToolUpdatePreview> {
    return this.#runToolUpdate(() =>
      previewSessionToolUpdate(this.#toolUpdateDependencies(), user.id, input),
    );
  }

  detailForUser: SessionDetailLookup = (...parameters) =>
    this.#dependencies.store.get(...parameters);

  readForUser = this.detailForUser;

  historyForUser: SessionHistoryAction = (
    user,
    sessionId,
    cursor,
    workspaceId,
  ) => {
    return readAuthorizedSessionHistory(this.#dependencies.store, user, {
      cursor,
      sessionId,
      workspaceId,
    });
  };

  reassignForUser: SessionReassignmentAction = (
    user,
    sessionId,
    runnerId,
    workingDirectory,
    workspaceId,
  ) => {
    const change = () => {
      const input: SessionReassignmentInput = { runnerId, workingDirectory };
      const result = reassignSession(
        this.#dependencies,
        user.id,
        sessionId,
        input,
      );
      if (result.status !== "reassigned") {
        throw new RealtimeCommandError(sessionReassignmentError(result));
      }
      this.#dependencies.notify(user.id, sessionId);
      return result.detail;
    };
    return this.#withOwnedDetail(user, sessionId, workspaceId, change);
  };

  setAutoCompactionForUser: SessionAutoCompactionAction = (...parameters) =>
    this.#setCompactionFlag("setAutoCompact", ...parameters);

  setIdleCompactionForUser: SessionAutoCompactionAction = (...parameters) =>
    this.#setCompactionFlag("setIdleCompact", ...parameters);

  #setCompactionFlag(
    setter: "setAutoCompact" | "setIdleCompact",
    ...[
      user,
      sessionId,
      enabled,
      workspaceId,
    ]: Parameters<SessionAutoCompactionAction>
  ): ReturnType<SessionAutoCompactionAction> {
    return this.#withOwnedDetail(user, sessionId, workspaceId, () => {
      const detail = this.#dependencies.store[setter](
        user.id,
        sessionId,
        enabled,
        this.#dependencies.now(),
        workspaceId,
      );
      if (detail === undefined) {
        throw new RealtimeCommandError("not_found");
      }
      this.#dependencies.notify(user.id, sessionId);
      return detail;
    });
  }

  setContextTokenCapForUser(
    ...parameters: Parameters<SessionContextTokenCapAction>
  ) {
    return this.#contextTokenCapAction(...parameters);
  }

  stopForUser: SessionStopAction = async (
    user,
    sessionId,
    cascade,
    workspaceId,
  ) =>
    stopSessionForUser({
      cascade,
      dependencies: this.#dependencies,
      sessionId,
      user,
      workspaceId,
    });

  summariesForUser(userId: string, workspaceId: string) {
    return this.#dependencies.store.list(userId, workspaceId);
  }

  #providerUpdateStoreAccess() {
    return {
      resources: this.#dependencies.store.writeResources(),
    };
  }

  async updateProviderForUser(
    user: AuthenticatedUser,
    input: SessionProviderUpdateInput,
  ): Promise<AgentSessionDetail> {
    return updateSessionProviderWithPool({
      dependencies: {
        apply: (userId, resolved, rejectCredentialErrors) =>
          this.#applyProviderUpdate(userId, resolved, rejectCredentialErrors),
        pool: this.#dependencies.modelCredentialPool,
      },
      input,
      user,
    });
  }

  async #applyProviderUpdate(
    userId: string,
    input: SessionProviderUpdateInput,
    rejectCredentialErrors: boolean,
  ): Promise<AgentSessionDetail> {
    const outcome = await applyResolvedSessionProviderUpdate({
      dependencies: {
        ...this.#dependencies.providerUpdates,
        discoverModels: this.#dependencies.discoverModels,
        discoverOpenRouterProviders:
          this.#dependencies.discoverOpenRouterProviders,
        providers: this.#dependencies.providers,
        rejectCredentialErrors,
        restartSignal: this.#dependencies.restartSignal,
      },
      input,
      store: this.#providerUpdateStoreAccess(),
      userId,
    });
    return this.#notifyUpdatedSession(userId, input.sessionId, outcome);
  }

  async updateToolsForUser(
    user: AuthenticatedUser,
    input: SessionToolUpdateInput,
  ): Promise<AgentSessionDetail> {
    const applied = await this.#runToolUpdate(() =>
      applySessionToolUpdate(this.#toolUpdateDependencies(), user.id, input),
    );
    return this.#notifyUpdatedSession(user.id, input.sessionId, applied);
  }

  #notifyUpdatedSession(...parameters: [string, string, AgentSessionDetail]) {
    this.#dependencies.notify(parameters[0], parameters[1]);
    return parameters[2];
  }

  #withOwnedDetail<Value>(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string | undefined,
    action: (detail: AgentSessionDetail) => Value,
  ) {
    return action(this.#detail(user.id, sessionId, workspaceId));
  }

  async #runToolUpdate<Value>(action: () => Promise<Value>): Promise<Value> {
    try {
      return await action();
    } catch (error) {
      throw this.#toolUpdateError(error);
    }
  }

  #toolUpdateDependencies(): SessionToolUpdateDependencies {
    return {
      ...this.#dependencies.toolUpdates,
      readCredentialSource: async (userId, detail) =>
        (await this.#credential(userId, detail)).source,
      store: this.#dependencies.store.writeResources(),
    };
  }

  #toolUpdateError(error: unknown): RealtimeCommandError {
    return new RealtimeCommandError(
      error instanceof SessionToolUpdateError ? error.code : "command_failed",
    );
  }

  async #queueOwned(options: {
    readonly input?: PromptInput;
    readonly sessionId: string;
    readonly user: AuthenticatedUser;
    readonly workspaceId?: string;
  }): Promise<AgentSessionDetail> {
    this.#detail(options.user.id, options.sessionId, options.workspaceId);
    return this.#queue(
      options.user,
      options.sessionId,
      options.input,
      options.workspaceId,
    );
  }

  async #queue(
    user: AuthenticatedUser,
    sessionId: string,
    prompt?: PromptInput,
    workspaceId?: string,
  ): Promise<AgentSessionDetail> {
    const response = await queueSessionForUser(
      {
        ...this.#dependencies,
        credential: this.#credentialAction(),
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
      user.id,
      sessionId,
      prompt,
    );
    return this.#detailFromResponse(user.id, sessionId, response);
  }

  #credentialAction(): SessionCredentialOperation {
    return async (userId, detail, action) =>
      action(await this.#credential(userId, detail));
  }

  async #detailFromResponse(
    userId: string,
    sessionId: string,
    response: Response,
  ): Promise<AgentSessionDetail> {
    await responseValue(response);
    return this.#detail(userId, sessionId);
  }

  #detail(
    userId: string,
    sessionId: string,
    workspaceId?: string,
  ): AgentSessionDetail {
    return requiredSessionDetail(
      this.#dependencies.store.get.bind(this.#dependencies.store),
      [userId, sessionId, workspaceId],
      () => new RealtimeCommandError("not_found"),
    );
  }
}
