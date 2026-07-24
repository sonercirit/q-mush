import { AGENT_REASONING_EFFORTS } from "../shared/agent-configuration.ts";
import { createAgentSystemPrompt } from "../shared/agent-prompt.ts";
import {
  AGENT_SESSION_TOOL_OPTIONS,
  selectedAgentTools,
} from "../shared/agent-tools.ts";
import { ProviderCredentialStore } from "../shared/provider-credential-store.ts";
import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
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
import { readSessionSnapshot } from "./session-store-agent-read.ts";
import type { PendingSpawnedSession } from "./session-store-spawns.ts";

const optionsPageOffset = (page: number): number =>
  (page - 1) * SESSION_OPTIONS_PAGE_SIZE;

interface SessionAgentActionsDependencies extends SessionAgentActionDependencies {
  readonly abortSession: (sessionId: string) => void;
  readonly activeSession: (sessionId: string) => boolean;
  readonly broker: Pick<RunnerCommandBroker, "cancelSession">;
  readonly listRunnerOptions: (
    userId: string,
    offset: number,
    limit: number,
    workspaceId: string,
    search?: string,
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

  actions(parentSessionId: string, userId: string): SessionAgentToolActions {
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
      continueSession: (sessionId) =>
        this.#queue(userId, anotherSession(sessionId), parentWorkspaceId()),
      getSessionOptions: (input) =>
        this.#options(userId, input, parentWorkspaceId()),
      listSessions: () =>
        sessionToolOutput(
          this.#dependencies.store.list(userId, parentWorkspaceId()),
        ),
      readSession: (input) => this.#read(userId, input, parentWorkspaceId()),
      sendToSession: (sessionId, message) =>
        this.#queue(
          userId,
          anotherSession(sessionId),
          parentWorkspaceId(),
          message,
        ),
      spawnSession: (input) => this.#spawn(parentSessionId, userId, input),
      stopSession: (sessionId) =>
        this.#stop(parentSessionId, userId, sessionId, parentWorkspaceId()),
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
      current.status !== "running"
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
      !this.#dependencies.activeSession(parent.id) &&
      this.#dependencies.runnerIsAvailable(
        userId,
        parent.runnerId,
        parent.workspaceId,
      )
    ) {
      void this.#queue(userId, parent.id, parent.workspaceId);
    }
  }

  #detail(
    userId: string,
    sessionId: string,
    workspaceId?: string,
  ): AgentSessionDetail {
    const found = this.#dependencies.store.get(userId, sessionId, workspaceId);
    if (found === undefined) {
      throw new Error("Session not found");
    }
    return found;
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
      roles: (["user", "assistant"] as const).filter((role) =>
        selected.has(role),
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
      systemPrompt: createAgentSystemPrompt(detail.agentFile),
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
        ? this.#dependencies.listRunnerOptions(
            userId,
            offset,
            SESSION_OPTIONS_PAGE_SIZE,
            workspaceId,
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
    workspaceId?: string,
    message?: string,
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
      )
    ) {
      return sessionToolOutput({ error: "runner_unavailable" });
    }
    const response = await this.#dependencies.withCredential(
      userId,
      { ...target, workspaceId: target.workspaceId },
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
    const parentWorkspaceId = this.#dependencies.store.get(
      userId,
      parentSessionId,
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
      dependencies: this.#dependencies,
      input,
      parentSessionId,
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
