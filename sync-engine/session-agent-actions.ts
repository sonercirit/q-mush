import { AGENT_REASONING_EFFORTS } from "../shared/agent-configuration.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import {
  AGENT_SESSION_TOOL_OPTIONS,
  selectedAgentTools,
  type SessionAgentToolName,
} from "../shared/agent-tools.ts";
import { ProviderCredentialStore } from "../shared/provider-credential-store.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { safeAgentModelDiscoveryError } from "./agent-model-discovery.ts";
import { createJsonResponse } from "./http.ts";
import {
  pauseQueuedSessionForRestart,
  responseToolOutput,
  sessionCanResume,
  spawnAgentSession,
  spawnedSessionReport,
  type SessionAgentActionDependencies,
} from "./session-agent-action-helpers.ts";
import {
  SESSION_OPTIONS_PAGE_SIZE,
  sessionOptionsOutput,
  sessionOptionsPageFilter,
  type GetSessionOptionsToolInput,
  type SessionOptionsSource,
} from "./session-agent-options.ts";
import {
  readSessionOutput,
  type ReadSessionToolInput,
} from "./session-agent-read.ts";
import {
  sessionToolOutput,
  type SessionAgentToolActions,
  type SpawnSessionToolInput,
} from "./session-agent-tools.ts";
import { unavailableSessionResponse } from "./session-availability.ts";
import type { SessionDetailLookup } from "./session-command-types.ts";
import type { SessionExecutionAuthority } from "./session-execution-authority.ts";
import type {
  RunnerDirectoryBrowseResult,
  RunnerDirectoryRequest,
} from "./session-request-helpers.ts";
import type { SessionRunnerAvailability } from "./session-runner-availability.ts";
import { readSessionSnapshot } from "./session-store-agent-read.ts";
import type { PendingSpawnedSession } from "./session-store-spawns.ts";

const optionsPageOffset = (page: number): number =>
  (page - 1) * SESSION_OPTIONS_PAGE_SIZE;

function runnerUnavailableOutput(): string {
  return sessionToolOutput({ error: "runner_unavailable" });
}

type CancelSession = (sessionId: string) => void;

interface RunnerPageRequest {
  readonly limit: number;
  readonly offset: number;
  readonly search?: string;
  readonly workspaceId?: string;
}

interface SessionAgentActionsDependencies extends SessionAgentActionDependencies {
  readonly abortSession: (sessionId: string) => void;
  readonly activeSession: (sessionId: string) => boolean;
  readonly broker: Pick<RunnerCommandBroker, "cancelSession">;
  readonly cleanupSession: (detail: AgentSessionDetail) => void;
  readonly browseDirectories: (
    request: RunnerDirectoryRequest,
    signal: AbortSignal,
  ) => Promise<RunnerDirectoryBrowseResult>;
  readonly listOnlineRunners: (
    userId: string,
    workspaceId?: string,
  ) => readonly RunnerSummary[];
  readonly listRunnerOptions: (
    userId: string,
    request: RunnerPageRequest,
  ) => {
    readonly items: SessionOptionsSource["runners"];
    readonly totalItems: number;
  };
}

export class SessionAgentActions {
  readonly #dependencies: SessionAgentActionsDependencies;

  constructor(dependencies: SessionAgentActionsDependencies) {
    this.#dependencies = dependencies;
  }

  actions(
    parentSessionId: string,
    userId: string,
    parentGeneration: number,
    signal: AbortSignal,
  ): SessionAgentToolActions {
    const authority: SessionExecutionAuthority = {
      generation: parentGeneration,
      sessionId: parentSessionId,
    };
    const currentParentTool = (tool: SessionAgentToolName): boolean =>
      this.#dependencies.store.executionIsCurrent(
        userId,
        parentSessionId,
        parentGeneration,
        tool,
      );
    const guardParent =
      <Arguments extends readonly unknown[], Result>(
        tool: SessionAgentToolName,
        action: (...arguments_: Arguments) => Result,
      ) =>
      (...arguments_: Arguments): Result => {
        if (!currentParentTool(tool)) {
          throw new DOMException("The agent session was stopped", "AbortError");
        }
        return action(...arguments_);
      };
    const parentWorkspaceId = (): string => {
      const workspaceId = this.#dependencies.store.get(
        userId,
        parentSessionId,
      )?.workspaceId;
      if (workspaceId === undefined) {
        throw new Error("The parent session is unavailable");
      }
      return workspaceId;
    };
    const anotherSession = (sessionId: string): string => {
      if (sessionId === parentSessionId) {
        throw new Error(
          "Choose another session; this session is already running",
        );
      }
      return sessionId;
    };
    return {
      continueSession: guardParent("continue_session", (sessionId) =>
        this.#queue(
          userId,
          anotherSession(sessionId),
          authority,
          undefined,
          parentWorkspaceId(),
        ),
      ),
      browseRunnerDirectories: (runnerId, path) =>
        this.#browseDirectories(
          userId,
          runnerId,
          path,
          authority,
          () => currentParentTool("browse_runner_directories"),
          signal,
          parentWorkspaceId(),
        ),
      getSessionOptions: guardParent("get_session_options", (input) =>
        this.#options(userId, input, parentWorkspaceId()),
      ),
      listRunners: guardParent("list_runners", () =>
        sessionToolOutput(
          this.#dependencies.listOnlineRunners(userId, parentWorkspaceId()),
        ),
      ),
      listSessions: guardParent("list_sessions", () =>
        sessionToolOutput(
          this.#dependencies.store.list(userId, parentWorkspaceId()),
        ),
      ),
      readSession: guardParent("read_session", (input) =>
        this.#read(userId, input, parentWorkspaceId()),
      ),
      reassignSession: guardParent(
        "reassign_session",
        (sessionId, runnerId, workingDirectory) =>
          this.#reassign(
            parentSessionId,
            userId,
            sessionId,
            runnerId,
            workingDirectory,
            parentWorkspaceId(),
          ),
      ),
      sendToSession: guardParent("send_to_session", (sessionId, message) =>
        this.#queue(
          userId,
          anotherSession(sessionId),
          authority,
          message,
          parentWorkspaceId(),
        ),
      ),
      spawnSession: guardParent("spawn_session", (input) =>
        this.#spawn(authority, userId, input),
      ),
      stopSession: guardParent("stop_session", (sessionId) =>
        this.#stop(parentSessionId, userId, sessionId, parentWorkspaceId()),
      ),
    };
  }

  #reportAndNotify(
    detail: AgentSessionDetail,
    userId: string,
  ): string | undefined {
    const parentId = this.#report(detail, userId);
    if (parentId !== undefined) {
      this.#dependencies.notify(userId, parentId);
    }
    return parentId;
  }

  reportAll(pending: readonly PendingSpawnedSession[]): void {
    const parentsByUser = new Map<string, string[]>();
    for (const { detail, userId } of pending) {
      const parentId = this.#reportAndNotify(detail, userId);
      if (parentId !== undefined) {
        const parents = parentsByUser.get(userId) ?? [];
        parents.push(parentId);
        parentsByUser.set(userId, parents);
      }
    }
    for (const [userId, parents] of parentsByUser) {
      this.#wakeParents(userId, parents);
    }
  }

  reportOne(detail: AgentSessionDetail, userId: string): void {
    this.#wakeReportedParent(this.#reportAndNotify(detail, userId), userId);
  }

  stopSession(sessionId: string, detail?: AgentSessionDetail): void {
    this.#cancelSession()(sessionId);
    if (detail !== undefined) {
      this.#dependencies.cleanupSession(detail);
    }
  }

  #cancelSession(): CancelSession {
    return (sessionId) => {
      this.#dependencies.abortSession(sessionId);
      this.#dependencies.broker.cancelSession(sessionId);
    };
  }

  #wakeReportedParent(parentId: string | undefined, userId: string): void {
    if (parentId !== undefined) {
      void this.#wake(parentId, userId);
    }
  }

  finished(detail: AgentSessionDetail, userId: string): void {
    const current = this.#dependencies.store.get(userId, detail.id);
    if (current !== undefined && sessionCanResume(current)) {
      this.reportOne(current, userId);
    }
  }

  #onlineRunnerExists(
    ...parameters: Parameters<SessionRunnerAvailability>
  ): boolean {
    const [userId, runnerId, workspaceId] = parameters;
    return this.#dependencies
      .listOnlineRunners(userId, workspaceId)
      .some((runner) => runner.id === runnerId);
  }

  async #browseDirectories(
    userId: string,
    runnerId: string,
    path: string,
    authority: SessionExecutionAuthority,
    authorize: () => boolean,
    signal: AbortSignal,
    workspaceId: string,
  ): Promise<string> {
    const online = this.#onlineRunnerExists(userId, runnerId, workspaceId);
    if (!online || !authorize()) {
      return runnerUnavailableOutput();
    }
    try {
      const result = await this.#dependencies.browseDirectories(
        {
          authorize,
          path,
          runnerId,
          sessionId: authority.sessionId,
          userId,
          workspaceId,
        },
        signal,
      );
      return sessionToolOutput(
        result.status === "listed" ? result.listing : { error: result.status },
      );
    } catch {
      return sessionToolOutput({ error: "directory_unavailable" });
    }
  }

  #report(detail: AgentSessionDetail, userId: string): string | undefined {
    const link = this.#dependencies.store.spawnedSessionLink(userId, detail.id);
    if (link === undefined) {
      return undefined;
    }
    const report = spawnedSessionReport({
      childId: detail.id,
      dependencies: this.#dependencies,
      parentId: link.parentId,
      userId,
    });
    if (
      report !== undefined &&
      this.#dependencies.store.appendSpawnedSessionReport(
        userId,
        detail.id,
        detail.generation,
        report.parentId,
        link.parentGeneration,
        report.content,
        this.#dependencies.now(),
      )
    ) {
      return report.parentId;
    }
    return undefined;
  }

  #wakeParents(userId: string, parentIds: readonly string[]): void {
    for (const parentId of new Set(parentIds)) {
      void this.#wake(parentId, userId);
    }
  }

  async #wake(parentSessionId: string, userId: string): Promise<void> {
    await this.#dependencies.settled?.(parentSessionId);
    const parent = this.#dependencies.store.get(userId, parentSessionId);
    if (
      parent !== undefined &&
      parent.status !== "stopped" &&
      sessionCanResume(parent) &&
      !this.#dependencies.activeSession(parent.id) &&
      this.#dependencies.runnerIsAvailable(
        userId,
        parent.runnerId,
        parent.workspaceId,
      )
    ) {
      void this.#queue(
        userId,
        parent.id,
        undefined,
        undefined,
        parent.workspaceId,
      );
    }
  }

  #detail(...parameters: Parameters<SessionDetailLookup>): AgentSessionDetail {
    const detail = this.#dependencies.store.get(...parameters);
    if (detail === undefined) {
      throw new Error("Session not found");
    }
    return detail;
  }

  #read(
    userId: string,
    input: ReadSessionToolInput,
    workspaceId: string,
  ): string {
    const selected = new Set(input.categories);
    const detail = readSessionSnapshot(this.#dependencies.database, {
      includeSystem: selected.has("system"),
      limit: input.limit,
      roles: (["user", "assistant", "thinking", "tool"] as const).filter(
        (role) => selected.has(role),
      ),
      sessionId: input.sessionId,
      userId,
      workspaceId,
    });
    if (detail === undefined) {
      throw new Error("Session not found");
    }
    return readSessionOutput({
      input,
      matchedRecords: detail.transcript.matchedRecords,
      messages: detail.transcript.messages,
      session: { id: detail.id, status: detail.status, title: detail.title },
      systemPrompt: createAgentSystemPrompt(
        detail.agentFile,
        detail.executionEnvironment,
      ),
      toolDefinitions: selectedAgentTools(detail.tools).map(
        ({ function: definition }) => definition,
      ),
    });
  }

  async #options(
    userId: string,
    input: GetSessionOptionsToolInput,
    workspaceId: string,
  ): Promise<string> {
    let models: SessionOptionsSource["models"] = [];
    let reasoningEfforts: SessionOptionsSource["reasoningEfforts"] =
      AGENT_REASONING_EFFORTS;
    if (
      input.category === "models" &&
      input.credentialId !== undefined &&
      input.provider !== undefined
    ) {
      const provider = input.provider;
      const credentialId = input.credentialId;
      if (
        !ProviderCredentialStore.hasActiveModelCredential(
          this.#dependencies.database,
          userId,
          provider,
          credentialId,
          workspaceId,
        )
      ) {
        throw new Error("The model credential or provider is unavailable");
      }
      let credential;
      try {
        credential = await this.#dependencies.readCredential(userId, {
          credentialId,
          provider,
          workspaceId,
        });
      } catch {
        throw new Error("The model credential or provider is unavailable");
      }
      if (credential?.id !== credentialId) {
        throw new Error("The model credential or provider is unavailable");
      }
      try {
        const catalog = await this.#dependencies.discoverModels(
          provider,
          credential,
        );
        models = catalog.models;
        reasoningEfforts = [];
      } catch (error) {
        throw new Error(safeAgentModelDiscoveryError(error), { cause: error });
      }
    }
    const offset = optionsPageOffset(input.page);
    const credentialPage =
      input.category === "credentials"
        ? ProviderCredentialStore.listModelCredentials(
            this.#dependencies.database,
            userId,
            offset,
            SESSION_OPTIONS_PAGE_SIZE,
            input.search,
            workspaceId,
          )
        : undefined;
    const runnerPage =
      input.category === "runners"
        ? this.#dependencies.listRunnerOptions(userId, {
            limit: SESSION_OPTIONS_PAGE_SIZE,
            offset,
            ...sessionOptionsPageFilter(input),
            workspaceId,
          })
        : undefined;
    return sessionOptionsOutput(input, {
      credentials: credentialPage?.items ?? [],
      models,
      ...(credentialPage === undefined && runnerPage === undefined
        ? {}
        : {
            page: {
              totalItems:
                credentialPage?.totalItems ?? runnerPage?.totalItems ?? 0,
            },
          }),
      reasoningEfforts,
      runners: runnerPage?.items ?? [],
      tools: AGENT_SESSION_TOOL_OPTIONS,
    });
  }

  #queuedResponse(userId: string, sessionId: string): Response {
    this.#dependencies.notify(userId, sessionId);
    return createJsonResponse({ sessionId, status: "queued" });
  }

  async #queue(
    userId: string,
    sessionId: string,
    authority?: SessionExecutionAuthority,
    message?: string,
    workspaceId?: string,
  ): Promise<string> {
    const target = this.#detail(userId, sessionId, workspaceId);
    const unavailable = unavailableSessionResponse(target);
    if (unavailable !== undefined) {
      return responseToolOutput(unavailable);
    }
    if (
      !this.#dependencies.runnerIsAvailable(
        userId,
        target.runnerId,
        target.workspaceId,
      ) &&
      this.#dependencies.pendingRestart(target.runnerId) === undefined
    ) {
      return runnerUnavailableOutput();
    }
    const response = await this.#dependencies.withCredential(
      userId,
      target,
      (credential) => {
        const queued = this.#dependencies.store.queue(
          userId,
          sessionId,
          this.#dependencies.now(),
          message === undefined ? undefined : { content: message, images: [] },
          {
            ...(authority === undefined ? {} : { parent: authority }),
            targetGeneration: target.generation,
          },
        );
        if (queued.status !== "queued") {
          return createJsonResponse({ error: queued.status }, 409);
        }
        if (this.#dependencies.pendingRestart(target.runnerId) !== undefined) {
          return this.#queuedResponse(userId, sessionId);
        }
        if (
          !this.#dependencies.launchSession(credential, queued.detail, userId)
        ) {
          if (
            pauseQueuedSessionForRestart(
              this.#dependencies,
              queued.detail,
              userId,
            )
          ) {
            return createJsonResponse({ error: "server_restarting" }, 503);
          }
          this.#dependencies.store.transitionRuntime(
            queued.detail.id,
            "failed",
            this.#dependencies.now(),
            queued.detail.generation,
          );
          this.#dependencies.notify(userId, sessionId);
          return createJsonResponse({ error: "session_launch_failed" }, 500);
        }
        return this.#queuedResponse(userId, sessionId);
      },
    );
    return responseToolOutput(response);
  }

  #reassign(
    parentSessionId: string,
    userId: string,
    sessionId: string,
    runnerId: string,
    workingDirectory: string,
    workspaceId: string,
  ): string {
    if (sessionId === parentSessionId) {
      throw new Error(
        "Choose another session; this session is already running",
      );
    }
    if (this.#detail(userId, sessionId, workspaceId).id !== sessionId) {
      throw new Error("Session not found");
    }
    const result = this.#dependencies.store.reassign(
      userId,
      sessionId,
      runnerId,
      workingDirectory,
      this.#dependencies.now(),
    );
    if (result.status !== "reassigned") {
      return result.status === "runner_unavailable"
        ? runnerUnavailableOutput()
        : sessionToolOutput({ error: `session_${result.status}` });
    }
    this.#dependencies.notify(userId, sessionId);
    return sessionToolOutput({
      runnerId,
      sessionId,
      status: "reassigned",
      workingDirectory,
    });
  }

  #spawn(
    authority: SessionExecutionAuthority,
    userId: string,
    input: SpawnSessionToolInput,
  ): Promise<string> {
    const parentWorkspaceId = this.#dependencies.store.get(
      userId,
      authority.sessionId,
    )?.workspaceId;
    if (parentWorkspaceId === undefined) {
      return Promise.resolve(
        sessionToolOutput({ error: "workspace_unavailable" }),
      );
    }
    if (
      !this.#dependencies.runnerIsAvailable(
        userId,
        input.runnerId,
        parentWorkspaceId,
      )
    ) {
      return Promise.resolve(
        sessionToolOutput({ error: "runner_unavailable" }),
      );
    }
    return spawnAgentSession({
      authority,
      dependencies: this.#dependencies,
      input,
      userId,
    });
  }

  #stop(
    parentSessionId: string,
    userId: string,
    sessionId: string,
    workspaceId: string,
  ): string {
    const target = this.#detail(userId, sessionId, workspaceId);
    if (target.status !== "stopped") {
      this.#dependencies.store.stop(
        userId,
        sessionId,
        this.#dependencies.now(),
      );
    }
    const cancel = this.#cancelSession();
    if (sessionId === parentSessionId) {
      queueMicrotask(() => {
        cancel(sessionId);
        this.#dependencies.cleanupSession(target);
      });
    } else {
      cancel(sessionId);
      this.#dependencies.cleanupSession(target);
    }
    this.#dependencies.notify(userId, sessionId);
    this.finished(target, userId);
    return sessionToolOutput({ sessionId, status: "stopped" });
  }
}
