import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { createJsonResponse } from "./http.ts";
import {
  responseToolOutput,
  spawnAgentSession,
  spawnedSessionReport,
  type SessionAgentActionDependencies,
} from "./session-agent-action-helpers.ts";
import {
  sessionToolOutput,
  type SessionAgentToolActions,
  type SpawnSessionToolInput,
} from "./session-agent-tools.ts";
import { unavailableSessionResponse } from "./session-availability.ts";
import type { PendingSpawnedSession } from "./session-store-spawns.ts";

interface SessionAgentActionsDependencies extends SessionAgentActionDependencies {
  readonly abortSession: (sessionId: string) => void;
  readonly broker: Pick<RunnerCommandBroker, "cancelSession">;
  readonly activeSession: (sessionId: string) => boolean;
  readonly cancelQuestions: (userId: string, sessionId: string) => void;
}

export class SessionAgentActions {
  readonly #dependencies: SessionAgentActionsDependencies;

  constructor(dependencies: SessionAgentActionsDependencies) {
    this.#dependencies = dependencies;
  }

  actions(parentSessionId: string, userId: string): SessionAgentToolActions {
    const anotherSession = (sessionId: string): string => {
      if (sessionId === parentSessionId) {
        throw new Error(
          "Choose another session; this session is already running",
        );
      }
      return sessionId;
    };
    return {
      continueSession: (sessionId) =>
        this.#queue(userId, anotherSession(sessionId)),
      listSessions: () =>
        sessionToolOutput(this.#dependencies.store.list(userId)),
      readSession: (sessionId) =>
        sessionToolOutput(this.#detail(userId, sessionId)),
      sendToSession: (sessionId, message) =>
        this.#queue(userId, anotherSession(sessionId), message),
      spawnSession: (input) => this.#spawn(parentSessionId, userId, input),
      stopSession: (sessionId) =>
        this.#stop(parentSessionId, userId, sessionId),
    };
  }

  reportAll(pending: readonly PendingSpawnedSession[]): void {
    const parentsByUser = new Map<string, string[]>();
    for (const { detail, userId } of pending) {
      const parentId = this.#parentSessionId(detail, userId);
      if (parentId !== undefined) {
        const parents = parentsByUser.get(userId) ?? [];
        parents.push(parentId);
        parentsByUser.set(userId, parents);
      }
      this.#report(detail, userId);
    }
    for (const [userId, parents] of parentsByUser) {
      this.#wakeParents(userId, parents);
    }
  }

  reportOne(detail: AgentSessionDetail, userId: string): void {
    const parentId = this.#parentSessionId(detail, userId);
    this.#report(detail, userId);
    if (parentId !== undefined) {
      this.#wake(parentId, userId);
    }
  }

  finished(detail: AgentSessionDetail, userId: string): void {
    const current = this.#dependencies.store.get(userId, detail.id);
    if (
      current !== undefined &&
      current.status !== "queued" &&
      current.status !== "running" &&
      current.status !== "waiting"
    ) {
      this.reportOne(current, userId);
    }
  }

  #parentSessionId(
    child: Pick<AgentSessionDetail, "id">,
    userId: string,
  ): string | undefined {
    return this.#dependencies.store.parentSessionId(userId, child.id);
  }

  #report(detail: AgentSessionDetail, userId: string): void {
    const parentSessionId = this.#parentSessionId(detail, userId);
    if (parentSessionId === undefined) {
      return;
    }
    const report = spawnedSessionReport({
      childId: detail.id,
      dependencies: this.#dependencies,
      parentId: parentSessionId,
      userId,
    });
    if (
      report !== undefined &&
      this.#dependencies.store.appendSpawnedSessionReport(
        userId,
        detail.id,
        report.parentId,
        report.content,
        this.#dependencies.now(),
      )
    ) {
      this.#dependencies.notify(userId, report.parentId);
    }
  }

  #wakeParents(userId: string, parentIds: readonly string[]): void {
    for (const parentId of new Set(parentIds)) {
      this.#wake(parentId, userId);
    }
  }

  #wake(parentSessionId: string, userId: string): void {
    const parent = this.#dependencies.store.get(userId, parentSessionId);
    if (
      parent !== undefined &&
      parent.status !== "queued" &&
      parent.status !== "running" &&
      parent.status !== "waiting" &&
      !this.#dependencies.activeSession(parent.id) &&
      this.#dependencies.runnerIsAvailable(userId, parent.runnerId)
    ) {
      void this.#queue(userId, parent.id);
    }
  }

  #detail(userId: string, sessionId: string): AgentSessionDetail {
    const found = this.#dependencies.store.get(userId, sessionId);
    if (found === undefined) {
      throw new Error("Session not found");
    }
    return found;
  }

  async #queue(
    userId: string,
    sessionId: string,
    message?: string,
  ): Promise<string> {
    const target = this.#detail(userId, sessionId);
    const unavailable = unavailableSessionResponse(target);
    if (unavailable !== undefined) {
      return responseToolOutput(unavailable);
    }
    if (!this.#dependencies.runnerIsAvailable(userId, target.runnerId)) {
      return sessionToolOutput({ error: "runner_unavailable" });
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
        );
        if (queued.status !== "queued") {
          return createJsonResponse({ error: queued.status });
        }
        if (
          !this.#dependencies.launchSession(credential, queued.detail, userId)
        ) {
          return createJsonResponse({ error: "server_restarting" }, 503);
        }
        this.#dependencies.notify(userId, sessionId);
        return createJsonResponse({ sessionId, status: "queued" });
      },
    );
    return responseToolOutput(response);
  }

  #spawn(
    parentSessionId: string,
    userId: string,
    input: SpawnSessionToolInput,
  ): Promise<string> {
    if (this.#dependencies.draining()) {
      return Promise.resolve(sessionToolOutput({ error: "server_restarting" }));
    }
    if (!this.#dependencies.runnerIsAvailable(userId, input.runnerId)) {
      return Promise.resolve(
        sessionToolOutput({ error: "runner_unavailable" }),
      );
    }
    return spawnAgentSession({
      dependencies: this.#dependencies,
      input,
      parentSessionId,
      userId,
    });
  }

  #stop(parentSessionId: string, userId: string, sessionId: string): string {
    const target = this.#detail(userId, sessionId);
    if (target.status !== "stopped") {
      const now = this.#dependencies.now();
      this.#dependencies.store.stop(userId, sessionId, now, () => {
        this.#dependencies.cancelQuestions(userId, sessionId);
      });
    }
    const cancel = () => {
      this.#dependencies.abortSession(sessionId);
      this.#dependencies.broker.cancelSession(sessionId);
    };
    if (sessionId === parentSessionId) {
      queueMicrotask(cancel);
    } else {
      cancel();
    }
    this.#dependencies.notify(userId, sessionId);
    this.finished(target, userId);
    return sessionToolOutput({ sessionId, status: "stopped" });
  }
}
