import { SESSIONS_PATH } from "../shared/routes.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { requestJson } from "./browser-http.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readSessionDetail } from "./session-codec.ts";
import { sessionDetailState } from "./session-controller-detail.ts";
import type { SessionRealtimeState } from "./session-controller-state.ts";
import {
  mergeNewerSelectedSessionSummary,
  sessionDataMatches,
  sessionSummariesMatch,
} from "./session-data-matching.ts";
import {
  runUnlessSessionMutation,
  sessionMutationPending,
} from "./session-pending.ts";
import { emptySessionReassignmentDraft } from "./session-reassignment-client.ts";
import { mostRecentSessionDirectory } from "./session-state.ts";
import { readSessionSummary } from "./session-summary-codec.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

async function loadSessionSummaries(
  transport?: SessionCommandTransport,
): Promise<readonly AgentSessionSummary[]> {
  const value: unknown =
    transport === undefined
      ? await requestJson(SESSIONS_PATH)
      : await transport.command(SESSION_REALTIME_OPERATIONS.subscribe, {});
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessions" in value) ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error("The server returned an invalid agent session list");
  }
  return value.sessions.map(readSessionSummary);
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

export interface SessionLoadController {
  readonly continueHydration: () => void;
  readonly hydrateAfterReconnect: () => void;
  readonly load: () => Promise<void>;
  readonly noteMutationStarted: () => void;
  readonly reconcileDetail: (
    sessionId: string,
  ) => Promise<AgentSessionDetail | undefined>;
  readonly reconcileSessions: (
    previousIds: ReadonlySet<string>,
    kind?: SessionCreationKind,
  ) => Promise<SessionCreationReconciliation | undefined>;
  readonly refresh: () => Promise<void>;
  readonly reset: () => void;
  readonly select: (sessionId: string) => Promise<void>;
}

export function createSessionLoadController(
  view: RevisionState<SessionViewState>,
  realtime: SessionRealtimeState,
  transport?: SessionCommandTransport,
): SessionLoadController {
  const state = {
    generation: 0,
    hydrating: false,
    hydrationPending: false,
    loadRevision: 0,
  };
  const hydrateAfterReconnect = (): void => {
    state.hydrationPending = true;
    continueHydration();
  };

  const continueHydration = (): void => {
    if (
      !state.hydrationPending ||
      state.hydrating ||
      transport === undefined ||
      sessionMutationPending(view.value)
    ) {
      return;
    }
    startHydration();
  };

  const startHydration = (): void => {
    state.generation += 1;
    state.hydrationPending = false;
    state.hydrating = true;
    void hydrate().finally(() => {
      state.hydrating = false;
      continueHydration();
    });
  };

  const noteMutationStarted = (): void => {
    if (state.hydrating) {
      state.generation += 1;
      state.hydrationPending = true;
    }
  };

  const reset = (): void => {
    state.generation += 1;
    state.hydrating = false;
    state.hydrationPending = false;
    state.loadRevision += 1;
  };

  const reconcileDetail = async (
    sessionId: string,
  ): Promise<AgentSessionDetail | undefined> => {
    const activeTransport = transport;
    const generation = state.generation;
    if (activeTransport === undefined || view.value.selectedId !== sessionId) {
      return undefined;
    }
    try {
      const detail = await loadSessionDetail(sessionId, activeTransport);
      if (
        generation !== state.generation ||
        view.value.selectedId !== sessionId ||
        !sessionMutationPending(view.value)
      ) {
        return undefined;
      }
      realtime.applyDetail(detail);
      return detail;
    } catch {
      return undefined;
    }
  };

  const reconcileSessions = async (
    previousIds: ReadonlySet<string>,
    kind: SessionCreationKind = "create",
  ): Promise<SessionCreationReconciliation | undefined> => {
    const pending = kind === "create" ? "creating" : "forking";
    const source = kind === "fork" ? view.value.detail : undefined;
    const reconciliationGeneration = state.generation;
    const sessions = await loadRealtimeSummaries();
    if (
      reconciliationGeneration !== state.generation ||
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
      if (!view.value[pending]) {
        return undefined;
      }
      const created = createdSessions[0];
      if (created === undefined) {
        return { sessions, status: "not_created" };
      }
      const reconciledId = created.id;
      const detail = await loadSessionDetail(reconciledId, transport);
      return reconciliationGeneration === state.generation
        ? { detail, sessions, status: "created" }
        : undefined;
    } catch {
      return undefined;
    }
  };

  const loadRealtimeSummaries = async (): Promise<
    readonly AgentSessionSummary[] | undefined
  > => {
    const activeTransport = transport;
    if (activeTransport === undefined) {
      return undefined;
    }
    try {
      return await loadSessionSummaries(activeTransport);
    } catch {
      return undefined;
    }
  };

  const hydrate = async (): Promise<void> => {
    const generation = state.generation;
    const sessions = await loadRealtimeSummaries();
    if (generation !== state.generation) {
      return;
    }
    if (sessions === undefined) {
      return;
    }
    if ((await transport?.yieldToStateApplication?.()) === false) {
      return;
    }
    if (generation !== state.generation) {
      return;
    }
    try {
      if (sessionMutationPending(view.value)) {
        state.hydrationPending = true;
        return;
      }
      realtime.applySessions(sessions);
      const selectedId = view.value.selectedId;
      if (selectedId === undefined) {
        return;
      }
      const detail = await loadSessionDetail(selectedId, transport);
      if (
        generation === state.generation &&
        !sessionMutationPending(view.value) &&
        view.value.selectedId === selectedId
      ) {
        // The durable request lives in the old segment after compaction;
        // reconnect hydration drops its transient copy unless the stream base
        // still proves that compaction is active.
        realtime.applyReconnectDetail(detail);
      } else {
        state.hydrationPending = true;
      }
    } catch {
      // A reconnect or mutation race that arrived during this request remains
      // queued; ordinary transport failures add no retry of their own.
    }
  };

  const beginView = (patch: Partial<SessionViewState>): number => {
    state.generation += 1;
    state.loadRevision += 1;
    view.begin(patch);
    return state.loadRevision;
  };

  const load = async (): Promise<void> => {
    const revision = beginView({
      detail: undefined,
      error: undefined,
      loadingDetail: false,
      selectedId: undefined,
      sessions: undefined,
      toolStreams: [],
    });
    if (transport !== undefined) {
      await loadRealtimeSessions(revision);
      continueHydration();
      return;
    }
    await loadSessions(revision, true);
  };

  const refresh = async (): Promise<void> => {
    const revision = state.loadRevision;
    const selectedId = view.value.selectedId;
    const detailRequest =
      selectedId === undefined
        ? undefined
        : loadSessionDetail(selectedId, transport).catch(() => undefined);
    await loadSessions(revision, false);
    const detail = await detailRequest;
    if (
      detail !== undefined &&
      revision === state.loadRevision &&
      view.value.selectedId === selectedId &&
      (view.value.detail?.updatedAt ?? -1) <= detail.updatedAt
    ) {
      applyDetail(detail, revision, false);
    }
  };

  const select = async (sessionId: string): Promise<void> => {
    return runUnlessSessionMutation(
      view.value,
      () => selectInternal(sessionId),
      Promise.resolve(),
    );
  };

  const selectInternal = async (sessionId: string): Promise<void> => {
    if (
      sessionId === view.value.selectedId &&
      view.value.detail !== undefined
    ) {
      return;
    }
    const revision = beginView({
      detail: undefined,
      error: undefined,
      followUp: "",
      followUpImages: [],
      loadingDetail: true,
      reassignment: emptySessionReassignmentDraft(),
      selectedId: sessionId,
      toolStreams: [],
    });
    await readDetail(sessionId, revision, true);
  };

  const patchRecentDirectory = (
    sessions: readonly AgentSessionSummary[],
  ): void => {
    if (view.value.creating) {
      return;
    }
    view.patch({
      draft: {
        ...view.value.draft,
        workingDirectory: mostRecentSessionDirectory(sessions),
      },
    });
  };

  const applySessions = (
    sessions: readonly AgentSessionSummary[],
    selectedId: string | undefined,
  ): void => {
    patchRecentDirectory(sessions);
    view.patch({ selectedId, sessions });
  };

  const reportInitialLoadFailure = (revision: number): void => {
    if (revision === state.loadRevision) {
      view.patch({
        error: "We could not load your agent sessions. Please try again.",
      });
    }
  };

  const loadRealtimeSessions = async (revision: number): Promise<void> => {
    const sessions = await loadRealtimeSummaries();
    if (sessions === undefined) {
      reportInitialLoadFailure(revision);
      return;
    }
    try {
      if (revision !== state.loadRevision) {
        return;
      }
      const selectedId = sessions[0]?.id;
      applySessions(sessions, selectedId);
      if (selectedId !== undefined) {
        await readDetail(selectedId, revision, true);
      }
    } catch {
      reportInitialLoadFailure(revision);
    }
  };

  const loadSessions = async (
    revision: number,
    initial: boolean,
  ): Promise<void> => {
    try {
      const sessions = await loadSessionSummaries();
      if (revision !== state.loadRevision) {
        return;
      }
      const previousId = initial ? undefined : view.value.selectedId;
      const selectedId =
        previousId !== undefined && sessions.some(({ id }) => id === previousId)
          ? previousId
          : sessions[0]?.id;
      const visibleSessions = mergeNewerSelectedSessionSummary(
        sessions,
        selectedId,
        view.value.detail,
      );
      if (
        selectedId !== view.value.selectedId ||
        !sessionSummariesMatch(view.value.sessions, visibleSessions)
      ) {
        applySessions(visibleSessions, selectedId);
      }
      if (selectedId === undefined) {
        if (view.value.detail !== undefined) {
          view.patch({ detail: undefined });
        }
      } else if (initial) {
        await readDetail(selectedId, revision, true);
      }
    } catch {
      if (initial) {
        reportInitialLoadFailure(revision);
      }
    }
  };

  const applyDetail = (
    detail: AgentSessionDetail,
    revision: number,
    showLoading: boolean,
  ): void => {
    if (revision !== state.loadRevision) {
      return;
    }
    const detailState = sessionDetailState(view.value, detail, {
      loadingDetail: false,
    });
    if (
      !showLoading &&
      !view.value.loadingDetail &&
      sessionDataMatches(view.value.detail, detail) &&
      sessionSummariesMatch(view.value.sessions, detailState.sessions)
    ) {
      return;
    }
    view.patch(detailState);
    realtime.applyDetail(detail);
  };

  const readDetail = async (
    sessionId: string,
    revision: number,
    showLoading: boolean,
  ): Promise<void> => {
    if (showLoading) {
      view.patch({ detail: undefined, loadingDetail: true });
    }
    try {
      const detail = await loadSessionDetail(sessionId, transport);
      if (view.value.selectedId === sessionId) {
        applyDetail(detail, revision, showLoading);
      }
    } catch {
      if (showLoading && revision === state.loadRevision) {
        view.patch({
          error: "We could not load that session transcript.",
          loadingDetail: false,
        });
      }
    }
  };
  return {
    continueHydration,
    hydrateAfterReconnect,
    load,
    noteMutationStarted,
    reconcileDetail,
    reconcileSessions,
    refresh,
    reset,
    select,
  };
}
