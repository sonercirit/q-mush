import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import { selectedAgentTools } from "../shared/agent-tool-selection.ts";
import { type SessionAgentToolName } from "../shared/agent-tools.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { ToolSettings } from "../shared/tool-limits.ts";
import { throwIfSignalAborted } from "../shared/validation.ts";
import { createJsonResponse } from "./http.ts";
import { pauseQueuedSessionForRestart, responseToolOutput, sessionCanResume, spawnAgentSession } from "./session-agent-action-helpers.ts";
import type { SessionAgentActionsDependencies } from "./session-agent-actions-dependencies.ts";
import { compactSessionForAgent, steerSessionForAgent, type CompactionSelection } from "./session-agent-control.ts";
import { listSessionsOutput } from "./session-agent-list.ts";
import { sessionAgentOptions } from "./session-agent-options-action.ts";
import type { GetSessionOptionsToolInput } from "./session-agent-options.ts";
import { readSessionOutput, type ReadSessionToolInput } from "./session-agent-read.ts";
import { sessionToolOutput, type SessionAgentToolActions, type SpawnSessionToolInput } from "./session-agent-tools.ts";
import { unavailableSessionResponse } from "./session-availability.ts";
import {
  reportCanWakeParent,
  reportSpawnedSessionCompletion,
  stopSpawnedSessionChildren,
  type SpawnedSessionCompletion,
} from "./session-child-lifecycle.ts";
import type { SessionDetailLookup } from "./session-command-types.ts";
import type { SessionExecutionAuthority } from "./session-execution-authority.ts";
import type { SessionRunnerAvailability } from "./session-runner-availability.ts";
import { readSessionSnapshot } from "./session-store-agent-read.ts";
import type { PendingSpawnedSession } from "./session-store-spawns.ts";

function runnerUnavailableOutput(): string {
  return sessionToolOutput({ error: "runner_unavailable" });
}

export interface SessionAgentActions {
  readonly actions: (
    parentSessionId: string,
    userId: string,
    parentGeneration: number,
    toolSettings: ToolSettings,
  ) => SessionAgentToolActions;
  readonly finished: (detail: AgentSessionDetail, userId: string) => void;
  readonly isDraining: () => boolean;
  readonly reportAll: (pending: readonly PendingSpawnedSession[]) => void;
  readonly reportOne: (detail: AgentSessionDetail, userId: string) => void;
  readonly reportedParent: (report: SpawnedSessionCompletion, userId: string) => void;
  readonly stopChildren: (parent: AgentSessionDetail, userId: string) => void;
  readonly stopSession: (sessionId: string, detail?: AgentSessionDetail) => void;
}

interface SessionAgentActionsError extends Error {
  readonly tag: "session_agent_actions";
}

function createSessionAgentActionsError(message: string): SessionAgentActionsError {
  const error = Object.assign(new Error(message), {
    tag: "session_agent_actions" as const,
  });
  if (!isSessionAgentActionsError(error)) {
    throw new Error("Failed to create a session agent actions error");
  }
  return error;
}

function isSessionAgentActionsError(error: unknown): error is SessionAgentActionsError {
  return error instanceof Error && "tag" in error && error.tag === "session_agent_actions";
}

export function createSessionAgentActions(dependencies: SessionAgentActionsDependencies): SessionAgentActions {
  function isDraining(): boolean {
    return dependencies.draining?.() === true;
  }

  function actions(parentSessionId: string, userId: string, parentGeneration: number, toolSettings: ToolSettings): SessionAgentToolActions {
    const authority: SessionExecutionAuthority = {
      generation: parentGeneration,
      sessionId: parentSessionId,
    };
    const currentParentTool = (tool: SessionAgentToolName): boolean =>
      dependencies.store.executionIsCurrent(userId, parentSessionId, parentGeneration, tool);
    const guardParent =
      <Arguments extends readonly unknown[], Result>(tool: SessionAgentToolName, action: (...arguments_: Arguments) => Result) =>
      (...arguments_: Arguments): Result => {
        if (!currentParentTool(tool)) {
          throw new DOMException("The agent session was stopped", "AbortError");
        }
        return action(...arguments_);
      };
    const parentWorkspaceId = (): string => {
      const workspaceId = dependencies.store.get(userId, parentSessionId)?.workspaceId;
      if (workspaceId === undefined) {
        throw createSessionAgentActionsError("The parent session is unavailable");
      }
      return workspaceId;
    };
    const anotherSession = (sessionId: string): string => {
      if (sessionId === parentSessionId) {
        throw createSessionAgentActionsError("Choose another session; this session is already running");
      }
      return sessionId;
    };
    return {
      compactSession: guardParent("compact_session", (sessionId, callSignal) =>
        compact({
          authority: { ...authority, tool: "compact_session" },
          sessionId,
          signal: callSignal,
          userId,
          workspaceId: parentWorkspaceId(),
        }),
      ),
      continueSession: guardParent("continue_session", (sessionId, callSignal) =>
        queue(userId, anotherSession(sessionId), authority, undefined, parentWorkspaceId(), callSignal),
      ),
      browseRunnerDirectories: (runnerId, path, callSignal) =>
        browseDirectories(
          userId,
          runnerId,
          path,
          authority,
          () => currentParentTool("browse_runner_directories"),
          // Cancels the broker command at the limit; the wrapper still
          // reports timed-out even when an execution never settles.
          callSignal,
          parentWorkspaceId(),
        ),
      getSessionOptions: guardParent("get_session_options", (input, callSignal) => options(userId, input, parentWorkspaceId(), callSignal)),
      listRunners: guardParent("list_runners", () => sessionToolOutput(dependencies.listOnlineRunners(userId, parentWorkspaceId()))),
      listSessions: guardParent("list_sessions", (input) =>
        listSessionsOutput(input, dependencies.store.list(userId, parentWorkspaceId())),
      ),
      readSession: guardParent("read_session", (input) => read(userId, input, parentWorkspaceId(), toolSettings)),
      reassignSession: guardParent("reassign_session", (sessionId, runnerId, workingDirectory, callSignal) =>
        reassign(parentSessionId, userId, sessionId, runnerId, workingDirectory, parentWorkspaceId(), callSignal),
      ),
      sendToSession: guardParent("send_to_session", (sessionId, message, callSignal) =>
        queue(userId, anotherSession(sessionId), authority, message, parentWorkspaceId(), callSignal),
      ),
      spawnSession: guardParent("spawn_session", (input, callSignal) => spawn(authority, userId, input, callSignal)),
      steerSession: guardParent("steer_session", (sessionId, message, callSignal) =>
        steer(userId, sessionId, message, parentWorkspaceId(), callSignal),
      ),
      stopSession: guardParent("stop_session", (sessionId, cascade, callSignal) =>
        stop(parentSessionId, userId, sessionId, cascade, parentWorkspaceId(), callSignal),
      ),
    };
  }

  function reportAndNotify(detail: AgentSessionDetail, userId: string): SpawnedSessionCompletion | undefined {
    const reported = reportSpawnedSessionCompletion(dependencies, detail, userId);
    if (reported === undefined) return undefined;
    const notifiedSessionId = reported.disposition === "terminal" ? detail.id : reported.parentId;
    dependencies.notify(userId, notifiedSessionId);
    return reported;
  }

  function wakeReport(report: SpawnedSessionCompletion | undefined, userId: string): void {
    if (reportCanWakeParent(report)) {
      wakeReportedParent(report.parentId, userId);
    }
  }

  function reportAll(pending: readonly PendingSpawnedSession[]): void {
    const parentsByUser = new Map<string, string[]>();
    for (const { detail, userId } of pending) {
      const report = reportAndNotify(detail, userId);
      if (reportCanWakeParent(report)) {
        const parents = parentsByUser.get(userId) ?? [];
        parents.push(report.parentId);
        parentsByUser.set(userId, parents);
      }
    }
    for (const [userId, parents] of parentsByUser) {
      for (const parentId of new Set(parents)) {
        wakeReport({ disposition: "delivered", parentId }, userId);
      }
    }
  }

  function reportOne(detail: AgentSessionDetail, userId: string): void {
    wakeReport(reportAndNotify(detail, userId), userId);
  }

  function reportedParent(report: SpawnedSessionCompletion, userId: string): void {
    dependencies.notify(userId, report.parentId);
    wakeReport(report, userId);
  }

  function stopSession(sessionId: string, detail?: AgentSessionDetail): void {
    cancel(sessionId);
    if (detail !== undefined) {
      dependencies.cleanupSession(detail);
    }
  }

  function stopChildren(parent: AgentSessionDetail, userId: string): void {
    stopSpawnedSessionChildren(
      dependencies,
      parent,
      userId,
      (child) => {
        stopSession(child.id, child);
      },
      (report) => {
        wakeReport(report, userId);
      },
    );
  }

  const cancel = (sessionId: string): void => {
    dependencies.abortSession(sessionId);
    dependencies.broker.cancelSessionCommands(sessionId);
  };

  function wakeReportedParent(parentId: string | undefined, userId: string): void {
    if (parentId !== undefined) {
      void wake(parentId, userId);
    }
  }

  function finished(detail: AgentSessionDetail, userId: string): void {
    const current = dependencies.store.get(userId, detail.id);
    if (current !== undefined && sessionCanResume(current)) {
      reportOne(current, userId);
    }
  }

  function onlineRunnerExists(...parameters: Parameters<SessionRunnerAvailability>): boolean {
    const [userId, runnerId, workspaceId] = parameters;
    return dependencies.listOnlineRunners(userId, workspaceId).some((runner) => runner.id === runnerId);
  }

  async function browseDirectories(
    userId: string,
    runnerId: string,
    path: string,
    authority: SessionExecutionAuthority,
    authorize: () => boolean,
    signal: AbortSignal,
    workspaceId: string,
  ): Promise<string> {
    const online = onlineRunnerExists(userId, runnerId, workspaceId);
    throwIfSignalAborted(signal, "Directory browsing was canceled");
    if (!online || !authorize()) {
      return runnerUnavailableOutput();
    }
    try {
      const result = await dependencies.browseDirectories(
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
      throwIfSignalAborted(signal, "Directory browsing was canceled");
      return sessionToolOutput(result.status === "listed" ? result.listing : { error: result.status });
    } catch {
      throwIfSignalAborted(signal, "Directory browsing was canceled");
      return sessionToolOutput({ error: "directory_unavailable" });
    }
  }

  async function wake(parentSessionId: string, userId: string): Promise<void> {
    await dependencies.settled?.(parentSessionId);
    const parent = dependencies.store.get(userId, parentSessionId);
    if (
      parent?.status === "idle" &&
      parent.pendingQuestions === null &&
      parent.restartHandoff === null &&
      sessionCanResume(parent) &&
      !dependencies.activeSession(parent.id) &&
      dependencies.runnerIsAvailable(userId, parent.runnerId, parent.workspaceId)
    ) {
      void queue(userId, parent.id, undefined, undefined, parent.workspaceId);
    }
  }

  function detail(...parameters: Parameters<SessionDetailLookup>): AgentSessionDetail {
    const detail = dependencies.store.get(...parameters);
    if (detail === undefined) {
      throw createSessionAgentActionsError("Session not found");
    }
    return detail;
  }

  function read(userId: string, input: ReadSessionToolInput, workspaceId: string, toolSettings: ToolSettings): string {
    const selected = new Set(input.categories);
    const detail = readSessionSnapshot(dependencies.database, {
      includeSystem: selected.has("system"),
      limit: input.limit,
      roles: (["user", "assistant", "thinking", "tool", "error"] as const).filter((role) => selected.has(role)),
      sessionId: input.sessionId,
      userId,
      workspaceId,
    });
    if (detail === undefined) {
      throw createSessionAgentActionsError("Session not found");
    }
    return readSessionOutput({
      input,
      matchedRecords: detail.transcript.matchedRecords,
      messages: detail.transcript.messages,
      session: { id: detail.id, status: detail.status, title: detail.title },
      systemPrompt: createAgentSystemPrompt(detail.agentFile, detail.executionEnvironment, toolSettings),
      toolDefinitions: selectedAgentTools(detail.tools, toolSettings).map(({ function: definition }) => definition),
    });
  }

  async function options(userId: string, input: GetSessionOptionsToolInput, workspaceId: string, signal: AbortSignal): Promise<string> {
    return sessionAgentOptions({
      dependencies: dependencies,
      input,
      signal,
      userId,
      workspaceId,
    });
  }

  function queuedResponse(userId: string, sessionId: string): Response {
    dependencies.notify(userId, sessionId);
    return createJsonResponse({ sessionId, status: "queued" });
  }

  async function queue(
    userId: string,
    sessionId: string,
    authority?: SessionExecutionAuthority,
    message?: string,
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const target = detail(userId, sessionId, workspaceId);
    const unavailable = unavailableSessionResponse(target);
    if (unavailable !== undefined) {
      return responseToolOutput(unavailable);
    }
    if (
      !dependencies.runnerIsAvailable(userId, target.runnerId, target.workspaceId) &&
      dependencies.pendingRestart(target.runnerId) === undefined
    ) {
      return runnerUnavailableOutput();
    }
    const response = await dependencies.withCredential(userId, target, (credential) => {
      // Credential access can outlive the tool deadline; never queue or
      // launch after the caller already reported timed-out.
      throwIfSignalAborted(signal, "The queue request was canceled");
      const queued = dependencies.store.queue(
        userId,
        sessionId,
        dependencies.now(),
        message === undefined ? undefined : { content: message, images: [] },
        {
          ...(authority === undefined ? {} : { parent: authority }),
          targetGeneration: target.generation,
        },
      );
      if (queued.status !== "queued") {
        return createJsonResponse({ error: queued.status }, 409);
      }
      if (dependencies.pendingRestart(target.runnerId) !== undefined) {
        return queuedResponse(userId, sessionId);
      }
      if (!dependencies.launchSession(credential, queued.detail, userId)) {
        if (pauseQueuedSessionForRestart(dependencies, queued.detail, userId)) {
          return createJsonResponse({ error: "server_restarting" }, 503);
        }
        dependencies.store.settleRuntimeFailure(
          queued.detail.id,
          "Session failed: the child session could not be launched",
          dependencies.now(),
          queued.detail.generation,
        );
        const failed = dependencies.store.get(userId, sessionId) ?? queued.detail;
        dependencies.notify(userId, sessionId);
        reportOne(failed, userId);
        return createJsonResponse({ error: "session_launch_failed" }, 500);
      }
      return queuedResponse(userId, sessionId);
    });
    return responseToolOutput(response);
  }

  function reassign(
    parentSessionId: string,
    userId: string,
    sessionId: string,
    runnerId: string,
    workingDirectory: string,
    workspaceId: string,
    signal: AbortSignal,
  ): string {
    if (sessionId === parentSessionId) {
      throw createSessionAgentActionsError("Choose another session; this session is already running");
    }
    if (detail(userId, sessionId, workspaceId).id !== sessionId) {
      throw createSessionAgentActionsError("Session not found");
    }
    throwIfSignalAborted(signal, "The reassignment was canceled");
    const result = dependencies.store.reassign(userId, sessionId, runnerId, workingDirectory, dependencies.now());
    if (result.status !== "reassigned") {
      return result.status === "runner_unavailable" ? runnerUnavailableOutput() : sessionToolOutput({ error: `session_${result.status}` });
    }
    dependencies.notify(userId, sessionId);
    return sessionToolOutput({
      runnerId,
      sessionId,
      status: "reassigned",
      workingDirectory,
    });
  }

  function spawn(authority: SessionExecutionAuthority, userId: string, input: SpawnSessionToolInput, signal: AbortSignal): Promise<string> {
    const parentWorkspaceId = dependencies.store.get(userId, authority.sessionId)?.workspaceId;
    if (parentWorkspaceId === undefined) {
      return Promise.resolve(sessionToolOutput({ error: "workspace_unavailable" }));
    }
    if (!dependencies.runnerIsAvailable(userId, input.runnerId, parentWorkspaceId)) {
      return Promise.resolve(sessionToolOutput({ error: "runner_unavailable" }));
    }
    return spawnAgentSession({
      authority,
      dependencies: dependencies,
      input,
      signal,
      terminal: (detail) => {
        reportOne(detail, userId);
      },
      userId,
    });
  }

  function compact(input: CompactionSelection): Promise<string> {
    return compactSessionForAgent(dependencies, input);
  }

  function steer(userId: string, sessionId: string, message: string, workspaceId: string, signal: AbortSignal): Promise<string> {
    return steerSessionForAgent(dependencies, {
      message,
      sessionId,
      signal,
      userId,
      workspaceId,
    });
  }

  function stop(
    parentSessionId: string,
    userId: string,
    sessionId: string,
    cascade: boolean,
    workspaceId: string,
    signal: AbortSignal,
  ): string {
    const target = detail(userId, sessionId, workspaceId);
    throwIfSignalAborted(signal, "The stop was canceled");
    if (target.status !== "stopped") {
      dependencies.store.stop(userId, sessionId, dependencies.now());
      if (cascade) stopChildren(target, userId);
    }
    const cancelAfterResponse = cancel;
    if (sessionId === parentSessionId) {
      queueMicrotask(() => {
        cancelAfterResponse(sessionId);
        dependencies.cleanupSession(target);
      });
    } else {
      cancel(sessionId);
      dependencies.cleanupSession(target);
    }
    dependencies.notify(userId, sessionId);
    finished(target, userId);
    return sessionToolOutput({ sessionId, status: "stopped" });
  }
  return {
    actions,
    finished,
    isDraining,
    reportAll,
    reportOne,
    reportedParent,
    stopChildren,
    stopSession,
  };
}
