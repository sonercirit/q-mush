import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import {
  selectedAgentTools,
  type SessionAgentToolName,
} from "../shared/agent-tools.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createJsonResponse } from "./http.ts";
import {
  pauseQueuedSessionForRestart,
  responseToolOutput,
  sessionCanResume,
  spawnAgentSession,
  type SessionAgentActionDependencies,
} from "./session-agent-action-helpers.ts";
import {
  compactSessionForAgent,
  steerSessionForAgent,
  type SessionControlActionDependencies,
} from "./session-agent-control.ts";
import { listSessionsOutput } from "./session-agent-list.ts";
import {
  sessionAgentOptions,
  type SessionRunnerPageRequest,
} from "./session-agent-options-action.ts";
import type {
  GetSessionOptionsToolInput,
  SessionOptionsSource,
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
import {
  reportSpawnedSessionCompletion,
  stopSpawnedSessionChildren,
  type SpawnedSessionCompletion,
} from "./session-child-lifecycle.ts";
import type { SessionDetailLookup } from "./session-command-types.ts";
import type { SessionExecutionAuthority } from "./session-execution-authority.ts";
import type {
  RunnerDirectoryBrowseResult,
  RunnerDirectoryRequest,
} from "./session-request-helpers.ts";
import type { SessionRunnerAvailability } from "./session-runner-availability.ts";
import { readSessionSnapshot } from "./session-store-agent-read.ts";
import type { PendingSpawnedSession } from "./session-store-spawns.ts";

function runnerUnavailableOutput(): string {
  return sessionToolOutput({ error: "runner_unavailable" });
}

type RunnerPageRequest = SessionRunnerPageRequest;

interface SessionAgentActionsDependencies
  extends SessionAgentActionDependencies, SessionControlActionDependencies {
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
      compactSession: guardParent("compact_session", (sessionId) =>
        this.#compact({
          authority: { ...authority, tool: "compact_session" },
          sessionId,
          userId,
          workspaceId: parentWorkspaceId(),
        }),
      ),
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
      listSessions: guardParent("list_sessions", (input) =>
        listSessionsOutput(
          input,
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
      steerSession: guardParent("steer_session", (sessionId, message) =>
        this.#steer(userId, sessionId, message, parentWorkspaceId()),
      ),
      stopSession: guardParent("stop_session", (sessionId, cascade) =>
        this.#stop(
          parentSessionId,
          userId,
          sessionId,
          cascade,
          parentWorkspaceId(),
        ),
      ),
    };
  }

  #reportAndNotify(
    detail: AgentSessionDetail,
    userId: string,
  ): SpawnedSessionCompletion | undefined {
    const reported = reportSpawnedSessionCompletion(
      this.#dependencies,
      detail,
      userId,
    );
    if (reported !== undefined) {
      this.#dependencies.notify(userId, reported.parentId);
    }
    return reported;
  }

  #wakeReport(
    report: SpawnedSessionCompletion | undefined,
    userId: string,
  ): void {
    if (report?.disposition === "delivered") {
      this.#wakeReportedParent(report.parentId, userId);
    }
  }

  reportAll(pending: readonly PendingSpawnedSession[]): void {
    const parentsByUser = new Map<string, string[]>();
    for (const { detail, userId } of pending) {
      const report = this.#reportAndNotify(detail, userId);
      if (report?.disposition === "delivered") {
        const parents = parentsByUser.get(userId) ?? [];
        parents.push(report.parentId);
        parentsByUser.set(userId, parents);
      }
    }
    for (const [userId, parents] of parentsByUser) {
      for (const parentId of new Set(parents)) {
        this.#wakeReport({ disposition: "delivered", parentId }, userId);
      }
    }
  }

  reportOne(detail: AgentSessionDetail, userId: string): void {
    this.#wakeReport(this.#reportAndNotify(detail, userId), userId);
  }

  stopSession(sessionId: string, detail?: AgentSessionDetail): void {
    this.#cancel(sessionId);
    if (detail !== undefined) {
      this.#dependencies.cleanupSession(detail);
    }
  }

  stopChildren(parent: AgentSessionDetail, userId: string): void {
    stopSpawnedSessionChildren(this.#dependencies, parent, userId, (child) => {
      this.stopSession(child.id, child);
    });
  }

  #cancel = (sessionId: string): void => {
    this.#dependencies.abortSession(sessionId);
    this.#dependencies.broker.cancelSession(sessionId);
  };

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
      roles: (
        ["user", "assistant", "thinking", "tool", "error"] as const
      ).filter((role) => selected.has(role)),
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
    return sessionAgentOptions({
      dependencies: this.#dependencies,
      input,
      userId,
      workspaceId,
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
          this.#dependencies.store.settleRuntimeFailure(
            queued.detail.id,
            "Session failed: the child session could not be launched",
            this.#dependencies.now(),
            queued.detail.generation,
          );
          const failed =
            this.#dependencies.store.get(userId, sessionId) ?? queued.detail;
          this.#dependencies.notify(userId, sessionId);
          this.reportOne(failed, userId);
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
      terminal: (detail) => {
        this.reportOne(detail, userId);
      },
      userId,
    });
  }

  #compact(input: {
    readonly authority: SessionExecutionAuthority & {
      readonly tool: "compact_session";
    };
    readonly sessionId: string;
    readonly userId: string;
    readonly workspaceId: string;
  }): Promise<string> {
    return compactSessionForAgent(this.#dependencies, input);
  }

  #steer(
    userId: string,
    sessionId: string,
    message: string,
    workspaceId: string,
  ): Promise<string> {
    return steerSessionForAgent(this.#dependencies, {
      message,
      sessionId,
      userId,
      workspaceId,
    });
  }

  #stop(
    parentSessionId: string,
    userId: string,
    sessionId: string,
    cascade: boolean,
    workspaceId: string,
  ): string {
    const target = this.#detail(userId, sessionId, workspaceId);
    if (target.status !== "stopped") {
      this.#dependencies.store.stop(
        userId,
        sessionId,
        this.#dependencies.now(),
      );
      if (cascade) this.stopChildren(target, userId);
    }
    const cancel = this.#cancel;
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
