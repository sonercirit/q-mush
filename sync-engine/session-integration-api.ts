import type { PendingAskQuestions } from "../shared/ask-questions.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { authenticatedGet } from "./authenticated-get.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  parseJsonRequest,
  requireRequestMethod,
} from "./http.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type { SessionDetailReader } from "./session-command-types.ts";
import { updateSessionCompactionMode } from "./session-compaction-actions.ts";
import type { SessionNotification } from "./session-creation.ts";
import type { SessionExecutionCleanup } from "./session-execution-cleanup.ts";
import { readPrompt, type PromptInput } from "./session-input.ts";
import type { DeliverRunnerCommands } from "./session-integration.ts";
import type { SessionLivenessWatchdog } from "./session-liveness-watchdog.ts";
import { openRouterProvidersForUser } from "./session-provider-selection.ts";
import { recoverAnsweredQuestions } from "./session-question-actions.ts";
import { reassignSessionRequest } from "./session-reassignment-request.ts";
import type { SessionRequestHelpers } from "./session-request-helpers.ts";
import type {
  RestartDrainSessionProgress,
  SessionRestartControl,
} from "./session-restart-control.ts";
import type {
  DurableRunnerRestartGate,
  SessionRestartCoordinator,
} from "./session-restart-coordinator.ts";
import type { RunnerRemovalCoordinator } from "./session-runner-removal.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import { readSessionStopInput } from "./session-stop-input.ts";
import type { SessionStore } from "./session-store.ts";
import { forRequestWorkspace } from "./session-workspace-request.ts";
import {
  requestSessionWorkspaceId,
  storedSessionResponse,
  withRequestSessionWorkspace,
  withStoredWorkspaceSession,
  type SessionWorkspaceReader,
} from "./session-workspace.ts";

type SessionModelsForUser = (
  request: Request,
  user: AuthenticatedUser,
) => Promise<Response>;

export interface SessionIntegrationApiResources {
  readonly auth: GoogleAuth;
  readonly broker: RunnerCommandBroker;
  readonly compactForUser: (
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string,
  ) => Promise<Response>;
  readonly createForUser: (
    request: Request,
    user: AuthenticatedUser,
    workspaceId: string,
  ) => Promise<Response>;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly executionCleanup: SessionExecutionCleanup;
  readonly launchQueuedSessions: (userId: string) => void;
  readonly liveness: Pick<
    SessionLivenessWatchdog,
    "runnerConnected" | "runnerDisconnected"
  >;
  readonly modelsForUser: SessionModelsForUser;
  readonly modelCredentialPool: Parameters<
    typeof openRouterProvidersForUser
  >[0]["pool"];
  readonly notify: SessionNotification;
  readonly now: typeof Date.now;
  readonly questionActions: Parameters<typeof recoverAnsweredQuestions>[0];
  readonly queueForUser: (
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string,
    prompt?: PromptInput,
  ) => Promise<Response>;
  readonly requests: SessionRequestHelpers;
  readonly restart: SessionRestartControl;
  readonly restartCoordinator: SessionRestartCoordinator;
  readonly runnerRemoval: RunnerRemovalCoordinator;
  readonly runtimes: SessionRuntimes;
  readonly stopChildren: (detail: AgentSessionDetail, userId: string) => void;
  readonly stopLivenessScans: () => void;
  readonly store: SessionStore;
  readonly withCredentialAccess: Parameters<
    typeof openRouterProvidersForUser
  >[0]["withCredential"];
  readonly workspaces: SessionWorkspaceReader;
}

type WorkspaceResponseAction<Result extends Promise<Response> | Response> = (
  user: AuthenticatedUser,
  workspaceId: string,
) => Result;

export abstract class SessionIntegrationApi implements SessionDetailReader {
  protected abstract readonly resources: SessionIntegrationApiResources;

  #forWorkspace(
    request: Request,
    action: WorkspaceResponseAction<Response>,
  ): Response;
  #forWorkspace(
    request: Request,
    action: WorkspaceResponseAction<Promise<Response> | Response>,
  ): Promise<Response> | Response;
  #forWorkspace(
    request: Request,
    action: (
      user: AuthenticatedUser,
      workspaceId: string,
    ) => Promise<Response> | Response,
  ): Promise<Response> | Response {
    return forRequestWorkspace(
      this.resources.requests,
      this.resources.workspaces,
      request,
      action,
    );
  }

  collection(request: Request): Response | Promise<Response> {
    return this.#forWorkspace(request, (user, workspaceId) => {
      switch (request.method) {
        case "GET":
          return createJsonResponse({
            sessions: this.resources.store.list(user.id, workspaceId),
          });
        case "POST":
          return this.resources.createForUser(request, user, workspaceId);
        default:
          return createMethodNotAllowedResponse("GET, POST");
      }
    });
  }

  #postForWorkspace(
    request: Request,
    action: (
      user: AuthenticatedUser,
      workspaceId: string,
    ) => Response | Promise<Response>,
  ): Promise<Response> {
    return Promise.resolve(
      this.resources.requests.postForUser(request, (user) => {
        const run = () =>
          withRequestSessionWorkspace(
            request,
            user,
            this.resources.workspaces,
            (workspaceId) => action(user, workspaceId),
          );
        return run();
      }),
    );
  }

  #queueWithoutPrompt(request: Request, sessionId: string): Promise<Response> {
    const queue = this.resources.queueForUser;
    return this.#postForWorkspace(request, (user, workspaceId) =>
      queue(user, sessionId, workspaceId),
    );
  }

  compact(request: Request, sessionId: string): Promise<Response> {
    return this.#postForWorkspace(request, (user, workspaceId) =>
      this.resources.compactForUser(user, sessionId, workspaceId),
    );
  }

  continue(request: Request, sessionId: string): Promise<Response> {
    return this.#queueWithoutPrompt(request, sessionId);
  }

  message(request: Request, sessionId: string): Promise<Response> {
    const run = async (user: AuthenticatedUser): Promise<Response> => {
      const input = await parseJsonRequest(request, readPrompt);
      return input === undefined
        ? createApiError("invalid_request", 400)
        : withRequestSessionWorkspace(
            request,
            user,
            this.resources.workspaces,
            (workspaceId) =>
              this.resources.queueForUser(user, sessionId, workspaceId, input),
          );
    };
    return Promise.resolve(
      this.resources.requests.authenticate(request, "POST", run),
    );
  }

  commitRunnerProcess(runnerId: string, processNonce?: string): void {
    this.resources.broker.commitRunnerProcess(runnerId, processNonce);
  }

  completeRunnerCommand(
    runnerId: string,
    commandId: string,
    result: Parameters<RunnerCommandBroker["complete"]>[2],
  ): boolean {
    return this.resources.broker.complete(runnerId, commandId, result);
  }

  deliverRunnerCommands: DeliverRunnerCommands = ({
    connectionGeneration,
    deliver,
    deliverCancellation,
    processNonce,
    runnerId,
  }) =>
    this.resources.broker.deliverRunnerCommands(
      runnerId,
      processNonce,
      deliver,
      deliverCancellation,
      connectionGeneration,
    );

  runnerConnectionGeneration(runnerId: string): number {
    return this.resources.broker.runnerConnectionGeneration(runnerId);
  }

  replaceRunnerConnection(runnerId: string, replacedGeneration: number): void {
    this.resources.broker.replaceRunnerConnection(runnerId, replacedGeneration);
  }

  acknowledgeRunnerCancellation(runnerId: string, commandId: string): boolean {
    return this.resources.broker.acknowledgeCancellation(runnerId, commandId);
  }

  drain(): Promise<void> {
    return this.resources.restart.drainServer().then(async () => {
      await Promise.allSettled(this.resources.executionCleanup.pending);
    });
  }

  drainProgress(): readonly RestartDrainSessionProgress[] {
    return this.resources.restart.drainProgress();
  }

  prepareFinalShutdown(): Promise<void> {
    this.resources.stopLivenessScans();
    return this.resources.restart.prepareServerShutdown();
  }

  drainRunner(runnerId: string, restartId: string): Promise<void> {
    return this.resources.restart.drainRunner(runnerId, restartId);
  }

  #authenticatedWorkspace(
    request: Request,
  ):
    | { readonly user: AuthenticatedUser; readonly workspaceId: string }
    | Response {
    const user = this.resources.auth.authenticatedUser(request);
    if (user === null) {
      return createApiError("unauthorized", 401);
    }
    const workspaceId = requestSessionWorkspaceId(
      request,
      user.id,
      this.resources.workspaces,
    );
    return workspaceId === undefined
      ? createApiError("workspace_unavailable", 409)
      : { user, workspaceId };
  }

  async directories(request: Request, runnerId: string): Promise<Response> {
    const authenticated = this.#authenticatedWorkspace(request);
    return authenticated instanceof Response
      ? authenticated
      : this.resources.requests.directories(
          request,
          runnerId,
          authenticated.workspaceId,
        );
  }

  detailForUser: SessionDetailReader["detailForUser"] = (
    userId,
    sessionId,
    workspaceId,
  ) => this.resources.store.get(userId, sessionId, workspaceId);

  item(request: Request, sessionId: string): Response {
    return this.#forWorkspace(request, (user, workspaceId) =>
      storedSessionResponse(
        this.resources.store,
        user.id,
        sessionId,
        workspaceId,
      ),
    );
  }

  listForUser(
    userId: string,
    workspaceId?: string,
  ): readonly AgentSessionSummary[] {
    return this.resources.store.list(userId, workspaceId);
  }

  pendingQuestionForUser(
    userId: string,
    sessionId: string,
  ): PendingAskQuestions | null {
    return this.resources.store.pendingQuestions(userId, sessionId);
  }

  #getForUser(
    request: Request,
    action: (user: AuthenticatedUser) => Promise<Response>,
  ): Promise<Response> {
    return authenticatedGet(request, {
      action,
      forUser: (requested, serve) =>
        this.resources.requests.forUser(requested, serve),
    });
  }

  models(request: Request): Promise<Response> {
    return this.#getForUser(
      request,
      this.resources.modelsForUser.bind(null, request),
    );
  }

  openRouterProviders(request: Request): Promise<Response> {
    return this.#getForUser(request, (user) =>
      openRouterProvidersForUser({
        discover: this.resources.discoverOpenRouterProviders,
        pool: this.resources.modelCredentialPool,
        request,
        user,
        withCredential: this.resources.withCredentialAccess,
      }),
    );
  }

  pendingRunnerRestart(runnerId: string): DurableRunnerRestartGate {
    const runtimeRestartId =
      this.resources.restart.pendingRunnerRestart(runnerId);
    const durableGate =
      this.resources.restartCoordinator.pendingRunnerRestart(runnerId);
    if (durableGate.status === "conflicted") {
      return durableGate;
    }
    if (runtimeRestartId === undefined) {
      return durableGate;
    }
    if (
      durableGate.status === "pending" &&
      (durableGate.requestedBy !== "runner" ||
        durableGate.restartId !== runtimeRestartId)
    ) {
      return { status: "conflicted" };
    }
    return {
      requestedBy: "runner",
      restartId: runtimeRestartId,
      status: "pending",
    };
  }

  async reassign(request: Request, sessionId: string): Promise<Response> {
    return reassignSessionRequest(
      {
        authenticate: this.resources.requests.authenticate,
        notify: this.resources.notify,
        now: this.resources.now,
        store: this.resources.store,
        workspaces: this.resources.workspaces,
      },
      request,
      sessionId,
    );
  }

  runnerConnected(runnerId: string): void {
    this.resources.restartCoordinator.recover(runnerId);
    void recoverAnsweredQuestions(this.resources.questionActions, runnerId);
    for (const userId of this.resources.store.queuedSessionOwnerIds()) {
      this.resources.launchQueuedSessions(userId);
    }
  }

  runnerDisconnected(runnerId: string): void {
    this.resources.liveness.runnerDisconnected(runnerId);
    const restartPending =
      this.resources.restart.draining() ||
      this.resources.restart.pendingRunnerRestart(runnerId) !== undefined;
    this.resources.broker.disconnectRunner(runnerId, !restartPending);
  }

  streamRunnerCommand(
    runnerId: string,
    commandId: string,
    delta: Parameters<RunnerCommandBroker["stream"]>[2],
  ): boolean {
    return this.resources.broker.stream(runnerId, commandId, delta);
  }

  runnerRestartReady(runnerId: string, restartId: string): void {
    if (!this.resources.restartCoordinator.resumeRunner(runnerId, restartId)) {
      return;
    }
    this.resources.restartCoordinator.recover(runnerId, restartId);
  }

  runnerOperational(runnerId: string, restartId?: string): void {
    this.resources.liveness.runnerConnected(runnerId);
    if (restartId !== undefined) {
      this.resources.restartCoordinator.recover(runnerId, restartId);
    }
  }

  async runnerRemoved(userId: string, runnerId: string): Promise<void> {
    await this.resources.runnerRemoval.removed(userId, runnerId);
  }

  async compaction(request: Request, sessionId: string): Promise<Response> {
    const methodError = requireRequestMethod(request, "POST");
    if (methodError !== undefined) {
      return methodError;
    }
    const authenticated = this.#authenticatedWorkspace(request);
    if (authenticated instanceof Response) {
      return authenticated;
    }
    return updateSessionCompactionMode(
      {
        auth: this.resources.auth,
        now: this.resources.now,
        onChanged: (detail, userId) => {
          this.resources.notify(userId, detail.id);
        },
        requiredWorkspaceId: authenticated.workspaceId,
        store: this.resources.store,
      },
      request,
      sessionId,
    );
  }

  async stop(request: Request, sessionId: string): Promise<Response> {
    const cascade =
      request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json") === true
        ? await parseJsonRequest(request, readSessionStopInput)
        : true;
    if (cascade === undefined) return createApiError("invalid_request", 400);
    return this.resources.requests.postForUser(request, (user) =>
      withRequestSessionWorkspace(
        request,
        user,
        this.resources.workspaces,
        (workspaceId) =>
          withStoredWorkspaceSession(
            this.resources.store,
            user,
            sessionId,
            workspaceId,
            async (existing) => {
              this.resources.runtimes.abort(sessionId);
              this.resources.broker.cancelSessionCommands(sessionId);
              await this.resources.runtimes.cleared(sessionId);
              if (existing.status !== "stopped") {
                this.resources.store.stop(
                  user.id,
                  sessionId,
                  this.resources.now(),
                );
                if (cascade) this.resources.stopChildren(existing, user.id);
              }
              await this.resources.executionCleanup.cleanupTerminal(existing);
              this.resources.notify(user.id, sessionId);
              return storedSessionResponse(
                this.resources.store,
                user.id,
                sessionId,
                workspaceId,
              );
            },
          ),
      ),
    );
  }
}
