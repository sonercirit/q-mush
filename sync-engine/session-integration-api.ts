import type { PendingAskQuestions } from "../shared/ask-questions.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { DEVELOPMENT_RESTART_LIFECYCLE_MS } from "../shared/development-shutdown.ts";
import { RestartDeadline } from "../shared/restart-deadline.ts";
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
import type { SessionRestartAbort } from "./session-restart-abort.ts";
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
import type { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
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
  readonly restartController: SessionRestartAbort;
  readonly restartCoordinator: SessionRestartCoordinator;
  readonly runnerRemoval: RunnerRemovalCoordinator;
  readonly runtimes: SessionRuntimes;
  readonly stopChildren: (detail: AgentSessionDetail, userId: string) => void;
  readonly stopLivenessScans: () => void;
  readonly shutdownInterrupted: Pick<
    ShutdownInterruptedSessionStore,
    "beginLiveDrain" | "enableRecovery"
  >;
  readonly store: SessionStore;
  readonly withCredentialAccess: Parameters<
    typeof openRouterProvidersForUser
  >[0]["withCredential"];
  readonly workspaces: SessionWorkspaceReader;
}

type CollectionMethod = "GET" | "POST";

function isCollectionMethod(method: string): method is CollectionMethod {
  return method === "GET" || method === "POST";
}

export type SessionIntegrationApi = ReturnType<
  typeof buildSessionIntegrationApi
>;

function buildSessionIntegrationApi(resources: SessionIntegrationApiResources) {
  const api = {
    forWorkspace(
      request: Request,
      action: (
        user: AuthenticatedUser,
        workspaceId: string,
      ) => Promise<Response> | Response,
    ): Promise<Response> | Response {
      return forRequestWorkspace(
        resources.requests,
        resources.workspaces,
        request,
        action,
      );
    },

    collection(request: Request): Response | Promise<Response> {
      return forRequestWorkspace(
        resources.requests,
        resources.workspaces,
        request,
        (user, workspaceId) => {
          const handlers: Record<
            CollectionMethod,
            () => Response | Promise<Response>
          > = {
            GET: () =>
              createJsonResponse({
                sessions: resources.store.list(user.id, workspaceId),
              }),
            POST: () => resources.createForUser(request, user, workspaceId),
          };
          return isCollectionMethod(request.method)
            ? handlers[request.method]()
            : createMethodNotAllowedResponse("GET, POST");
        },
      );
    },

    postForWorkspace(
      request: Request,
      action: (
        user: AuthenticatedUser,
        workspaceId: string,
      ) => Response | Promise<Response>,
    ): Promise<Response> {
      return Promise.resolve(
        resources.requests.postForUser(request, (user) => {
          const run = () =>
            withRequestSessionWorkspace(
              request,
              user,
              resources.workspaces,
              (workspaceId) => action(user, workspaceId),
            );
          return run();
        }),
      );
    },

    queueWithoutPrompt(request: Request, sessionId: string): Promise<Response> {
      const queue = resources.queueForUser;
      return api.postForWorkspace(request, (user, workspaceId) =>
        queue(user, sessionId, workspaceId),
      );
    },

    compact(request: Request, sessionId: string): Promise<Response> {
      return api.postForWorkspace(request, (user, workspaceId) =>
        resources.compactForUser(user, sessionId, workspaceId),
      );
    },

    continue(request: Request, sessionId: string): Promise<Response> {
      return api.queueWithoutPrompt(request, sessionId);
    },

    message(request: Request, sessionId: string): Promise<Response> {
      const run = async (user: AuthenticatedUser): Promise<Response> => {
        const input = await parseJsonRequest(request, readPrompt);
        return input === undefined
          ? createApiError("invalid_request", 400)
          : withRequestSessionWorkspace(
              request,
              user,
              resources.workspaces,
              (workspaceId) =>
                resources.queueForUser(user, sessionId, workspaceId, input),
            );
      };
      return Promise.resolve(
        resources.requests.authenticate(request, "POST", run),
      );
    },

    commitRunnerProcess(runnerId: string, processNonce?: string): void {
      resources.broker.commitRunnerProcess(runnerId, processNonce);
    },

    completeRunnerCommand(
      runnerId: string,
      commandId: string,
      result: Parameters<RunnerCommandBroker["complete"]>[2],
    ): boolean {
      return resources.broker.complete(runnerId, commandId, result);
    },

    deliverRunnerCommands: (({
      connectionGeneration,
      deliver,
      deliverCancellation,
      processNonce,
      runnerId,
    }) =>
      resources.broker.deliverRunnerCommands(
        runnerId,
        processNonce,
        deliver,
        deliverCancellation,
        connectionGeneration,
      )) satisfies DeliverRunnerCommands,

    runnerConnectionGeneration(runnerId: string): number {
      return resources.broker.runnerConnectionGeneration(runnerId);
    },

    replaceRunnerConnection(
      runnerId: string,
      replacedGeneration: number,
    ): void {
      resources.broker.replaceRunnerConnection(runnerId, replacedGeneration);
    },

    acknowledgeRunnerCancellation(
      runnerId: string,
      commandId: string,
    ): boolean {
      return resources.broker.acknowledgeCancellation(runnerId, commandId);
    },

    async drain(
      deadline = new RestartDeadline(
        resources.now() + DEVELOPMENT_RESTART_LIFECYCLE_MS,
        resources.now,
      ),
    ): Promise<void> {
      resources.restartController.abort(
        new DOMException("The server is restarting", "RestartHandoff"),
      );
      resources.shutdownInterrupted.beginLiveDrain();
      await resources.restart.drainServer(deadline);
      await resources.executionCleanup.drainPending(deadline);
    },

    async drainFinal(): Promise<void> {
      await resources.restart.drainServerFinal();
      await Promise.allSettled(resources.executionCleanup.pending);
    },

    escalateDrain(): boolean {
      return resources.restart.escalateServerDrain();
    },

    drainProgress(
      userId?: string,
      workspaceId?: string,
    ): readonly RestartDrainSessionProgress[] {
      if (userId === undefined) return resources.restart.drainProgress();
      return this.drainProgressForSessions(
        new Set(resources.store.list(userId, workspaceId).map(({ id }) => id)),
      );
    },

    drainProgressForSessions(
      sessionIds: ReadonlySet<string>,
    ): readonly RestartDrainSessionProgress[] {
      return resources.restart.drainProgress(undefined, (sessionId) =>
        sessionIds.has(sessionId),
      );
    },

    restoreDevelopmentDrainRecovery(): void {
      resources.shutdownInterrupted.enableRecovery();
      resources.restart.restoreServerDrain();
      resources.restartController.restore();
      // Sessions the abandoned drain already parked into durable handoffs, and
      // work queued while the gate was closed, only resume when recovery and
      // the queued launcher run again.
      api.resumeParkedAndQueued();
    },

    resumeParkedAndQueued(runnerId?: string): void {
      resources.restartCoordinator.recover(runnerId);
      for (const userId of resources.store.queuedSessionOwnerIds()) {
        resources.launchQueuedSessions(userId);
      }
    },

    async prepareFinalShutdown(): Promise<void> {
      resources.stopLivenessScans();
      resources.shutdownInterrupted.enableRecovery();
      await resources.restart.prepareServerShutdown();
    },

    drainRunner(runnerId: string, restartId: string): Promise<void> {
      return resources.restart.drainRunner(runnerId, restartId);
    },

    escalateRunnerDrain(runnerId: string, restartId: string): boolean {
      return resources.restart.escalateRunnerDrain(runnerId, restartId);
    },

    authenticatedWorkspace(
      request: Request,
    ):
      | { readonly user: AuthenticatedUser; readonly workspaceId: string }
      | Response {
      const user = resources.auth.authenticatedUser(request);
      if (user === null) {
        return createApiError("unauthorized", 401);
      }
      const workspaceId = requestSessionWorkspaceId(
        request,
        user.id,
        resources.workspaces,
      );
      return workspaceId === undefined
        ? createApiError("workspace_unavailable", 409)
        : { user, workspaceId };
    },

    async directories(request: Request, runnerId: string): Promise<Response> {
      const authenticated = api.authenticatedWorkspace(request);
      return authenticated instanceof Response
        ? authenticated
        : resources.requests.directories(
            request,
            runnerId,
            authenticated.workspaceId,
          );
    },

    detailForUser: ((userId, sessionId, workspaceId) =>
      resources.store.get(
        userId,
        sessionId,
        workspaceId,
      )) satisfies SessionDetailReader["detailForUser"],

    item(request: Request, sessionId: string): Response {
      const respond = (user: AuthenticatedUser, workspaceId: string) =>
        storedSessionResponse(resources.store, user.id, sessionId, workspaceId);
      return forRequestWorkspace(
        resources.requests,
        resources.workspaces,
        request,
        respond,
      );
    },

    listForUser(
      userId: string,
      workspaceId?: string,
    ): readonly AgentSessionSummary[] {
      return resources.store.list(userId, workspaceId);
    },

    pendingQuestionForUser(
      userId: string,
      sessionId: string,
    ): PendingAskQuestions | null {
      return resources.store.pendingQuestions(userId, sessionId);
    },

    getForUser(
      request: Request,
      action: (user: AuthenticatedUser) => Promise<Response>,
    ): Promise<Response> {
      return authenticatedGet(request, {
        action,
        forUser: (requested, serve) =>
          resources.requests.forUser(requested, serve),
      });
    },

    models(request: Request): Promise<Response> {
      return api.getForUser(
        request,
        resources.modelsForUser.bind(null, request),
      );
    },

    openRouterProviders(request: Request): Promise<Response> {
      return api.getForUser(request, (user) =>
        openRouterProvidersForUser({
          discover: resources.discoverOpenRouterProviders,
          pool: resources.modelCredentialPool,
          request,
          signal: resources.restartController.signal,
          user,
          withCredential: resources.withCredentialAccess,
        }),
      );
    },

    pendingRunnerRestart(runnerId: string): DurableRunnerRestartGate {
      const runtimeRestartId = resources.restart.pendingRunnerRestart(runnerId);
      const durableGate =
        resources.restartCoordinator.pendingRunnerRestart(runnerId);
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
    },

    async reassign(request: Request, sessionId: string): Promise<Response> {
      return reassignSessionRequest(
        {
          authenticate: resources.requests.authenticate,
          notify: resources.notify,
          now: resources.now,
          store: resources.store,
          workspaces: resources.workspaces,
        },
        request,
        sessionId,
      );
    },

    runnerConnected(runnerId: string): void {
      api.resumeParkedAndQueued(runnerId);
      void recoverAnsweredQuestions(resources.questionActions, runnerId);
    },

    runnerDisconnected(runnerId: string): void {
      resources.liveness.runnerDisconnected(runnerId);
      const restartPending =
        resources.restart.draining() ||
        resources.restart.pendingRunnerRestart(runnerId) !== undefined;
      resources.broker.disconnectRunner(runnerId, !restartPending);
    },

    streamRunnerCommand(
      runnerId: string,
      commandId: string,
      delta: Parameters<RunnerCommandBroker["stream"]>[2],
    ): boolean {
      return resources.broker.stream(runnerId, commandId, delta);
    },

    runnerRestartReady(runnerId: string, restartId: string): void {
      if (!resources.restartCoordinator.resumeRunner(runnerId, restartId)) {
        return;
      }
      resources.restartCoordinator.recover(runnerId, restartId);
    },

    runnerOperational(runnerId: string, restartId?: string): void {
      resources.liveness.runnerConnected(runnerId);
      if (restartId !== undefined) {
        resources.restartCoordinator.recover(runnerId, restartId);
      }
    },

    async runnerRemoved(userId: string, runnerId: string): Promise<void> {
      await resources.runnerRemoval.removed(userId, runnerId);
    },

    async compaction(request: Request, sessionId: string): Promise<Response> {
      const methodError = requireRequestMethod(request, "POST");
      if (methodError !== undefined) {
        return methodError;
      }
      const authenticated = api.authenticatedWorkspace(request);
      if (authenticated instanceof Response) {
        return authenticated;
      }
      return updateSessionCompactionMode(
        {
          auth: resources.auth,
          now: resources.now,
          onChanged: (detail, userId) => {
            resources.notify(userId, detail.id);
          },
          requiredWorkspaceId: authenticated.workspaceId,
          store: resources.store,
        },
        request,
        sessionId,
      );
    },

    async stop(request: Request, sessionId: string): Promise<Response> {
      const cascade =
        request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json") === true
          ? await parseJsonRequest(request, readSessionStopInput)
          : true;
      if (cascade === undefined) return createApiError("invalid_request", 400);
      return resources.requests.postForUser(request, (user) =>
        withRequestSessionWorkspace(
          request,
          user,
          resources.workspaces,
          (workspaceId) =>
            withStoredWorkspaceSession(
              resources.store,
              user,
              sessionId,
              workspaceId,
              async (existing) => {
                resources.runtimes.abort(sessionId);
                resources.broker.cancelSessionCommands(sessionId);
                await resources.runtimes.cleared(sessionId);
                if (existing.status !== "stopped") {
                  resources.store.stop(user.id, sessionId, resources.now());
                  if (cascade) resources.stopChildren(existing, user.id);
                }
                await resources.executionCleanup.cleanupTerminal(existing);
                resources.notify(user.id, sessionId);
                return storedSessionResponse(
                  resources.store,
                  user.id,
                  sessionId,
                  workspaceId,
                );
              },
            ),
        ),
      );
    },
  };
  return api;
}

export const createSessionIntegrationApi: (
  resources: SessionIntegrationApiResources,
) => SessionIntegrationApi = buildSessionIntegrationApi;
