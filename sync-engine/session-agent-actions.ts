import { AGENT_REASONING_EFFORTS } from "../shared/agent-configuration.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import {
  AGENT_SESSION_TOOL_OPTIONS,
  selectedAgentTools,
} from "../shared/agent-tools.ts";
import { ProviderCredentialStore } from "../shared/provider-credential-store.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { safeAgentModelDiscoveryError } from "./agent-model-discovery.ts";
import { createJsonResponse } from "./http.ts";
import {
  responseToolOutput,
  spawnAgentSession,
  spawnedSessionReport,
  type SessionAgentActionDependencies,
} from "./session-agent-action-helpers.ts";
import {
  SESSION_OPTIONS_PAGE_SIZE,
  sessionOptionsOutput,
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
import type { RunnerDirectoryBrowseResult } from "./session-request-helpers.ts";
import type { RunnerDirectoryRequest } from "./session-runner-directory-request.ts";
import { readSessionSnapshot } from "./session-store-agent-read.ts";
import type { PendingSpawnedSession } from "./session-store-spawns.ts";

const optionsPageOffset = (page: number): number =>
  (page - 1) * SESSION_OPTIONS_PAGE_SIZE;

function runnerUnavailableOutput(): string {
  return sessionToolOutput({ error: "runner_unavailable" });
}

interface SessionAgentActionsDependencies extends SessionAgentActionDependencies {
  readonly abortSession: (sessionId: string) => void;
  readonly activeSession: (sessionId: string) => boolean;
  readonly broker: Pick<RunnerCommandBroker, "cancelSession">;
  readonly browseDirectories: (
    request: RunnerDirectoryRequest,
  ) => Promise<RunnerDirectoryBrowseResult>;
  readonly listOnlineRunners: (userId: string) => readonly RunnerSummary[];
  readonly listRunnerOptions: (
    userId: string,
    offset: number,
    limit: number,
    search?: string,
  ) => {
    readonly items: SessionOptionsSource["runners"];
    readonly totalItems: number;
  };
}

function sessionCanResume(
  session: Pick<AgentSessionDetail, "runnerRequired" | "status">,
): boolean {
  return (
    !session.runnerRequired &&
    session.status !== "queued" &&
    session.status !== "running"
  );
}

export class SessionAgentActions {
  readonly #dependencies: SessionAgentActionsDependencies;

  constructor(dependencies: SessionAgentActionsDependencies) {
    this.#dependencies = dependencies;
  }

  actions(
    parentSessionId: string,
    userId: string,
    parentGeneration?: number,
  ): SessionAgentToolActions {
    const currentParent = (): boolean =>
      parentGeneration === undefined ||
      this.#dependencies.store.executionIsCurrent(
        parentSessionId,
        parentGeneration,
      );
    const guardParent =
      <Arguments extends readonly unknown[], Result>(
        action: (...arguments_: Arguments) => Result,
      ) =>
      (...arguments_: Arguments): Result => {
        if (!currentParent()) {
          throw new DOMException("The agent session was stopped", "AbortError");
        }
        return action(...arguments_);
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
      continueSession: guardParent((sessionId) =>
        this.#queue(userId, anotherSession(sessionId)),
      ),
      browseRunnerDirectories: (runnerId, path) =>
        this.#browseDirectories(userId, runnerId, path, currentParent),
      getSessionOptions: (input) => this.#options(userId, input),
      listRunners: () =>
        sessionToolOutput(this.#dependencies.listOnlineRunners(userId)),
      listSessions: () =>
        sessionToolOutput(this.#dependencies.store.list(userId)),
      readSession: (input) => this.#read(userId, input),
      reassignSession: guardParent((sessionId, runnerId, workingDirectory) =>
        this.#reassign(
          parentSessionId,
          userId,
          sessionId,
          runnerId,
          workingDirectory,
        ),
      ),
      sendToSession: guardParent((sessionId, message) =>
        this.#queue(userId, anotherSession(sessionId), message),
      ),
      spawnSession: guardParent((input) =>
        this.#spawn(parentSessionId, userId, input),
      ),
      stopSession: guardParent((sessionId) =>
        this.#stop(parentSessionId, userId, sessionId),
      ),
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
    if (current !== undefined && sessionCanResume(current)) {
      this.reportOne(current, userId);
    }
  }

  #onlineRunnerExists(userId: string, runnerId: string): boolean {
    return this.#dependencies
      .listOnlineRunners(userId)
      .some((runner) => runner.id === runnerId);
  }

  async #browseDirectories(
    userId: string,
    runnerId: string,
    path: string,
    authorize?: () => boolean,
  ): Promise<string> {
    const online = this.#onlineRunnerExists(userId, runnerId);
    if (!online || authorize?.() === false) {
      return runnerUnavailableOutput();
    }
    try {
      const result = await this.#dependencies.browseDirectories({
        ...(authorize === undefined ? {} : { authorize }),
        path,
        runnerId,
        userId,
      });
      return sessionToolOutput(
        result.status === "listed" ? result.listing : { error: result.status },
      );
    } catch {
      return sessionToolOutput({ error: "directory_unavailable" });
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
      sessionCanResume(parent) &&
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

  #read(userId: string, input: ReadSessionToolInput): string {
    const selected = new Set(input.categories);
    const detail = readSessionSnapshot(this.#dependencies.database, {
      includeSystem: selected.has("system"),
      limit: input.limit,
      roles: (["user", "assistant"] as const).filter((role) =>
        selected.has(role),
      ),
      sessionId: input.sessionId,
      userId,
    });
    if (detail === undefined) {
      throw new Error("Session not found");
    }
    return readSessionOutput({
      input,
      matchedRecords: detail.transcript.matchedRecords,
      messages: detail.transcript.messages,
      session: { id: detail.id, status: detail.status, title: detail.title },
      systemPrompt: createAgentSystemPrompt(detail.agentFile),
      toolDefinitions: selectedAgentTools(detail.tools).map(
        ({ function: definition }) => definition,
      ),
    });
  }

  async #options(
    userId: string,
    input: GetSessionOptionsToolInput,
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
        )
      ) {
        throw new Error("The model credential or provider is unavailable");
      }
      let credential;
      try {
        credential = await this.#dependencies.readCredential(userId, {
          credentialId,
          provider,
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
          )
        : undefined;
    const runnerPage =
      input.category === "runners"
        ? this.#dependencies.listRunnerOptions(
            userId,
            offset,
            SESSION_OPTIONS_PAGE_SIZE,
            input.search,
          )
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
        );
        if (queued.status !== "queued") {
          return createJsonResponse({ error: queued.status }, 409);
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

  #reassign(
    parentSessionId: string,
    userId: string,
    sessionId: string,
    runnerId: string,
    workingDirectory: string,
  ): string {
    if (sessionId === parentSessionId) {
      throw new Error(
        "Choose another session; this session is already running",
      );
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
      this.#dependencies.store.stop(
        userId,
        sessionId,
        this.#dependencies.now(),
      );
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
