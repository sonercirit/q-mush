import { SESSIONS_PATH } from "../shared/routes.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { requestJson } from "./browser-http.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail, readSessionList } from "./session-codec.ts";
import { sessionDetailState } from "./session-controller-detail.ts";
import {
  mergeNewerSelectedSessionSummary,
  sessionDataMatches,
  sessionSummariesMatch,
  type SessionRealtimeState,
} from "./session-controller-state.ts";
import {
  runUnlessSessionMutation,
  sessionMutationPending,
} from "./session-pending.ts";
import { emptySessionReassignmentDraft } from "./session-reassignment-client.ts";
import { mostRecentSessionDirectory } from "./session-state.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

async function loadSessionSummaries(
  transport?: SessionCommandTransport,
): Promise<readonly AgentSessionSummary[]> {
  return readSessionList(
    transport === undefined
      ? await requestJson(SESSIONS_PATH)
      : await transport.command(SESSION_REALTIME_OPERATIONS.subscribe, {}),
  );
}

async function loadSessionDetail(
  sessionId: string,
  transport?: SessionCommandTransport,
): Promise<AgentSessionDetail> {
  return readSessionDetail(
    transport === undefined
      ? await requestJson(`${SESSIONS_PATH}/${encodeURIComponent(sessionId)}`)
      : await transport.command(SESSION_REALTIME_OPERATIONS.read, {
          sessionId,
        }),
  );
}

export type SessionCreationReconciliation =
  | {
      readonly detail: AgentSessionDetail;
      readonly sessions: readonly AgentSessionSummary[];
      readonly status: "created";
    }
  | {
      readonly sessions: readonly AgentSessionSummary[];
      readonly status: "not_created";
    }
  | { readonly status: "ambiguous" };

type SessionCreationKind = "create" | "fork";

function forkCandidateMatches(
  candidate: AgentSessionSummary,
  source: AgentSessionDetail | undefined,
): boolean {
  return (
    source !== undefined &&
    candidate.parentSessionId === null &&
    candidate.title === `Fork of ${source.title}`.slice(0, 80) &&
    candidate.workspaceId === source.workspaceId
  );
}

function createdSessionsForKind(
  kind: SessionCreationKind,
  sessions: readonly AgentSessionSummary[],
  previousIds: ReadonlySet<string>,
  source: AgentSessionDetail | undefined,
): readonly AgentSessionSummary[] {
  const created = sessions.filter(({ id }) => !previousIds.has(id));
  return kind === "fork"
    ? created.filter((candidate) => forkCandidateMatches(candidate, source))
    : created;
}

export class SessionLoadController {
  #generation = 0;
  #hydrating = false;
  #hydrationPending = false;
  #loadRevision = 0;
  readonly #realtime: SessionRealtimeState;
  readonly #transport: SessionCommandTransport | undefined;
  readonly #view: RevisionState<SessionViewState>;

  constructor(
    view: RevisionState<SessionViewState>,
    realtime: SessionRealtimeState,
    transport?: SessionCommandTransport,
  ) {
    this.#view = view;
    this.#realtime = realtime;
    this.#transport = transport;
  }

  hydrateAfterReconnect(): void {
    this.#hydrationPending = true;
    this.continueHydration();
  }

  continueHydration(): void {
    if (
      !this.#hydrationPending ||
      this.#hydrating ||
      this.#transport === undefined ||
      sessionMutationPending(this.#view.value)
    ) {
      return;
    }
    this.#startHydration();
  }

  #startHydration(): void {
    this.#generation += 1;
    this.#hydrationPending = false;
    this.#hydrating = true;
    void this.#hydrate().finally(() => {
      this.#hydrating = false;
      this.continueHydration();
    });
  }

  noteMutationStarted(): void {
    if (this.#hydrating) {
      this.#generation += 1;
      this.#hydrationPending = true;
    }
  }

  reset(): void {
    this.#generation += 1;
    this.#hydrating = false;
    this.#hydrationPending = false;
    this.#loadRevision += 1;
  }

  async reconcileDetail(
    sessionId: string,
  ): Promise<AgentSessionDetail | undefined> {
    const transport = this.#transport;
    const generation = this.#generation;
    if (transport === undefined || this.#view.value.selectedId !== sessionId) {
      return undefined;
    }
    try {
      const detail = await loadSessionDetail(sessionId, transport);
      if (
        generation !== this.#generation ||
        this.#view.value.selectedId !== sessionId ||
        !sessionMutationPending(this.#view.value)
      ) {
        return undefined;
      }
      this.#realtime.applyDetail(detail);
      return detail;
    } catch {
      return undefined;
    }
  }

  async reconcileSessions(
    previousIds: ReadonlySet<string>,
    kind: SessionCreationKind = "create",
  ): Promise<SessionCreationReconciliation | undefined> {
    const pending = kind === "create" ? "creating" : "forking";
    const source = kind === "fork" ? this.#view.value.detail : undefined;
    const reconciliationGeneration = this.#generation;
    const sessions = await this.#loadRealtimeSummaries();
    if (
      reconciliationGeneration !== this.#generation ||
      sessions === undefined
    ) {
      return undefined;
    }
    try {
      const createdSessions = createdSessionsForKind(
        kind,
        sessions,
        previousIds,
        source,
      );
      if (createdSessions.length > 1) {
        return { status: "ambiguous" };
      }
      if (!this.#view.value[pending]) {
        return undefined;
      }
      const created = createdSessions[0];
      if (created === undefined) {
        return { sessions, status: "not_created" };
      }
      const reconciledId = created.id;
      const detail = await loadSessionDetail(reconciledId, this.#transport);
      return reconciliationGeneration === this.#generation
        ? { detail, sessions, status: "created" }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #loadRealtimeSummaries(): Promise<
    readonly AgentSessionSummary[] | undefined
  > {
    const transport = this.#transport;
    if (transport === undefined) {
      return undefined;
    }
    try {
      return await loadSessionSummaries(transport);
    } catch {
      return undefined;
    }
  }

  async #hydrate(): Promise<void> {
    const generation = this.#generation;
    const sessions = await this.#loadRealtimeSummaries();
    if (generation !== this.#generation) {
      return;
    }
    if (sessions === undefined) {
      return;
    }
    if ((await this.#transport?.yieldToStateApplication?.()) === false) {
      return;
    }
    if (generation !== this.#generation) {
      return;
    }
    try {
      if (sessionMutationPending(this.#view.value)) {
        this.#hydrationPending = true;
        return;
      }
      this.#realtime.applySessions(sessions);
      const selectedId = this.#view.value.selectedId;
      if (selectedId === undefined) {
        return;
      }
      const detail = await loadSessionDetail(selectedId, this.#transport);
      if (
        generation === this.#generation &&
        !sessionMutationPending(this.#view.value) &&
        this.#view.value.selectedId === selectedId
      ) {
        this.#realtime.applyReconnectDetail(detail);
      } else {
        this.#hydrationPending = true;
      }
    } catch {
      // A reconnect or mutation race that arrived during this request remains
      // queued; ordinary transport failures add no retry of their own.
    }
  }

  #beginView(patch: Partial<SessionViewState>): number {
    this.#generation += 1;
    this.#loadRevision += 1;
    this.#view.begin(patch);
    return this.#loadRevision;
  }

  async load(): Promise<void> {
    const revision = this.#beginView({
      detail: undefined,
      error: undefined,
      loadingDetail: false,
      selectedId: undefined,
      sessions: undefined,
      toolStreams: [],
    });
    if (this.#transport !== undefined) {
      await this.#loadRealtimeSessions(revision);
      this.continueHydration();
      return;
    }
    await this.#loadSessions(revision, true);
  }

  async refresh(): Promise<void> {
    const revision = this.#loadRevision;
    const selectedId = this.#view.value.selectedId;
    const detailRequest =
      selectedId === undefined
        ? undefined
        : loadSessionDetail(selectedId, this.#transport).catch(() => undefined);
    await this.#loadSessions(revision, false);
    const detail = await detailRequest;
    if (
      detail !== undefined &&
      revision === this.#loadRevision &&
      this.#view.value.selectedId === selectedId &&
      (this.#view.value.detail?.updatedAt ?? -1) <= detail.updatedAt
    ) {
      this.#applyDetail(detail, revision, false);
    }
  }

  async select(sessionId: string): Promise<void> {
    return runUnlessSessionMutation(
      this.#view.value,
      () => this.#select(sessionId),
      Promise.resolve(),
    );
  }

  async #select(sessionId: string): Promise<void> {
    if (
      sessionId === this.#view.value.selectedId &&
      this.#view.value.detail !== undefined
    ) {
      return;
    }
    const revision = this.#beginView({
      detail: undefined,
      error: undefined,
      followUp: "",
      followUpImages: [],
      loadingDetail: true,
      reassignment: emptySessionReassignmentDraft(),
      selectedId: sessionId,
      toolStreams: [],
    });
    await this.#readDetail(sessionId, revision, true);
  }

  #patchRecentDirectory(sessions: readonly AgentSessionSummary[]): void {
    if (this.#view.value.creating) {
      return;
    }
    this.#view.patch({
      draft: {
        ...this.#view.value.draft,
        workingDirectory: mostRecentSessionDirectory(sessions),
      },
    });
  }

  #applySessions(
    sessions: readonly AgentSessionSummary[],
    selectedId: string | undefined,
  ): void {
    this.#patchRecentDirectory(sessions);
    this.#view.patch({ selectedId, sessions });
  }

  #reportInitialLoadFailure(revision: number): void {
    if (revision === this.#loadRevision) {
      this.#view.patch({
        error: "We could not load your agent sessions. Please try again.",
      });
    }
  }

  async #loadRealtimeSessions(revision: number): Promise<void> {
    const sessions = await this.#loadRealtimeSummaries();
    if (sessions === undefined) {
      this.#reportInitialLoadFailure(revision);
      return;
    }
    try {
      if (revision !== this.#loadRevision) {
        return;
      }
      const selectedId = sessions[0]?.id;
      this.#applySessions(sessions, selectedId);
      if (selectedId !== undefined) {
        await this.#readDetail(selectedId, revision, true);
      }
    } catch {
      this.#reportInitialLoadFailure(revision);
    }
  }

  async #loadSessions(revision: number, initial: boolean): Promise<void> {
    try {
      const sessions = await loadSessionSummaries();
      if (revision !== this.#loadRevision) {
        return;
      }
      const previousId = initial ? undefined : this.#view.value.selectedId;
      const selectedId =
        previousId !== undefined && sessions.some(({ id }) => id === previousId)
          ? previousId
          : sessions[0]?.id;
      const visibleSessions = mergeNewerSelectedSessionSummary(
        sessions,
        selectedId,
        this.#view.value.detail,
      );
      if (
        selectedId !== this.#view.value.selectedId ||
        !sessionSummariesMatch(this.#view.value.sessions, visibleSessions)
      ) {
        this.#applySessions(visibleSessions, selectedId);
      }
      if (selectedId === undefined) {
        if (this.#view.value.detail !== undefined) {
          this.#view.patch({ detail: undefined });
        }
      } else if (initial) {
        await this.#readDetail(selectedId, revision, true);
      }
    } catch {
      if (initial) {
        this.#reportInitialLoadFailure(revision);
      }
    }
  }

  #applyDetail(
    detail: AgentSessionDetail,
    revision: number,
    showLoading: boolean,
  ): void {
    if (revision !== this.#loadRevision) {
      return;
    }
    const detailState = sessionDetailState(this.#view.value, detail, {
      loadingDetail: false,
    });
    if (
      !showLoading &&
      !this.#view.value.loadingDetail &&
      sessionDataMatches(this.#view.value.detail, detail) &&
      sessionSummariesMatch(this.#view.value.sessions, detailState.sessions)
    ) {
      return;
    }
    this.#view.patch(detailState);
    this.#realtime.applyDetail(detail);
  }

  async #readDetail(
    sessionId: string,
    revision: number,
    showLoading: boolean,
  ): Promise<void> {
    if (showLoading) {
      this.#view.patch({ detail: undefined, loadingDetail: true });
    }
    try {
      const detail = await loadSessionDetail(sessionId, this.#transport);
      if (this.#view.value.selectedId === sessionId) {
        this.#applyDetail(detail, revision, showLoading);
      }
    } catch {
      if (showLoading && revision === this.#loadRevision) {
        this.#view.patch({
          error: "We could not load that session transcript.",
          loadingDetail: false,
        });
      }
    }
  }
}
