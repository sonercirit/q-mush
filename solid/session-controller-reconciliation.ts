import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionCreationDescriptor } from "./session-controller-create.ts";
import { sessionDetailState } from "./session-controller-detail.ts";
import type {
  SessionCreationReconciliation,
  SessionLoadController,
} from "./session-controller-load.ts";
import { newestSessionHistoryState } from "./session-history-state.ts";
import type { SessionMutationAcknowledgement } from "./session-mutation-acknowledgement.ts";
import {
  acknowledgeSessionMutation,
  sessionMutationError,
  sessionSnapshotIsAtLeast,
  type SessionMutation,
} from "./session-mutations.ts";
import {
  cappedSessionCreationIds,
  type SessionCreationBaseline,
} from "./session-pending.ts";

export type DetailMutationOptions = SessionMutation & {
  readonly success?: Partial<SessionViewState>;
};

interface UnknownCreationReconciliation {
  readonly baseline: SessionCreationBaseline;
  readonly descriptor: SessionCreationDescriptor;
  readonly error: unknown;
  readonly kind: "creation";
  readonly revision: number;
}

interface UnknownForkReconciliation {
  readonly baseline: SessionCreationBaseline;
  readonly error: unknown;
  readonly kind: "fork";
  readonly revision: number;
}

interface UnknownDetailReconciliation {
  readonly baseline: AgentSessionDetail;
  readonly error: unknown;
  readonly kind: "detail";
  readonly options: DetailMutationOptions;
  readonly revision: number;
}

type UnknownMutationReconciliation =
  | UnknownCreationReconciliation
  | UnknownDetailReconciliation
  | UnknownForkReconciliation;

/** @public Monotonic detail comparison used by reconciliation tests. */
export function sessionDetailIsAtLeast(
  candidate: AgentSessionDetail,
  reference: AgentSessionDetail,
): boolean {
  return sessionSnapshotIsAtLeast(candidate, reference);
}

/** @public Monotonic detail reconciliation helper. */
export function reconcileSessionDetail(
  current: AgentSessionDetail | undefined,
  incoming: AgentSessionDetail,
): AgentSessionDetail {
  if (current === undefined) {
    return incoming;
  }
  return current.id === incoming.id && sessionDetailIsAtLeast(incoming, current)
    ? incoming
    : current;
}

/** @public Coalesces duplicate summaries at their newest revisions. */
export function newestSessionSummaries(
  summaries: readonly AgentSessionSummary[],
): readonly AgentSessionSummary[] {
  const newestById = new Map<string, AgentSessionSummary>();
  for (const summary of summaries) {
    const current = newestById.get(summary.id);
    if (current === undefined || sessionSnapshotIsAtLeast(summary, current)) {
      newestById.set(summary.id, summary);
    }
  }
  return [...newestById.values()];
}

/** @public Reconciles summary collections without revision rollback. */
export function reconcileSessionSummaries(
  current: readonly AgentSessionSummary[],
  incoming: readonly AgentSessionSummary[],
): readonly AgentSessionSummary[] {
  const incomingById = new Map(
    newestSessionSummaries(incoming).map((summary) => [summary.id, summary]),
  );
  return [
    ...current.map((summary) => {
      const candidate = incomingById.get(summary.id);
      incomingById.delete(summary.id);
      return candidate !== undefined &&
        sessionSnapshotIsAtLeast(candidate, summary)
        ? candidate
        : summary;
    }),
    ...incomingById.values(),
  ];
}

interface DetailAcknowledgementOptions {
  readonly baseline: AgentSessionDetail;
  readonly matches: (detail: AgentSessionDetail) => boolean;
}

/** @public Reconciles mutation acknowledgements against their baseline. */
export function acknowledgeSessionDetail(
  current: AgentSessionDetail | undefined,
  acknowledgement: AgentSessionDetail,
  options: DetailAcknowledgementOptions,
): SessionMutationAcknowledgement {
  if (
    !sessionDetailIsAtLeast(acknowledgement, options.baseline) ||
    !options.matches(acknowledgement)
  ) {
    return { status: "uncertain" };
  }
  return {
    detail: reconcileSessionDetail(current, acknowledgement),
    status: "committed",
  };
}

function selectedSessionId(
  state: SessionViewState,
  sessions: readonly AgentSessionSummary[],
): string | undefined {
  return state.selectedId !== undefined &&
    sessions.some(({ id }) => id === state.selectedId)
    ? state.selectedId
    : sessions[0]?.id;
}

function reconciledSessions(
  state: SessionViewState,
  incoming: readonly AgentSessionSummary[],
): readonly AgentSessionSummary[] {
  return state.sessions === undefined
    ? incoming
    : reconcileSessionSummaries(state.sessions, incoming);
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function creationMatchesDescriptor(
  detail: AgentSessionDetail,
  descriptor: SessionCreationDescriptor,
): boolean {
  const initialMessage = detail.messages.find(({ role }) => role === "user");
  return (
    detail.autoCompact === descriptor.autoCompact &&
    detail.idleCompact === descriptor.idleCompact &&
    detail.agentFilePath === (descriptor.agentFilePath || null) &&
    detail.credentialId === descriptor.credentialId &&
    detail.executionEnvironment === descriptor.executionEnvironment &&
    detail.provider === descriptor.provider &&
    detail.reasoningEffort === (descriptor.reasoningEffort || null) &&
    detail.generation === 0 &&
    detail.runnerId === descriptor.runnerId &&
    detail.workingDirectory === descriptor.workingDirectory &&
    detail.model === descriptor.model &&
    detail.userContextTokenCap === descriptor.userContextTokenCap &&
    detail.openRouterProviderTag ===
      (descriptor.openRouterProviderTag || null) &&
    sameStringSet(detail.tools, descriptor.tools) &&
    (detail.messages.length === 0
      ? descriptor.prompt.length === 0 && descriptor.images.length === 0
      : initialMessage?.content === descriptor.prompt &&
        JSON.stringify(initialMessage.images) ===
          JSON.stringify(descriptor.images))
  );
}

function creationErrorState(
  reconciliation: UnknownCreationReconciliation,
): Partial<SessionViewState> {
  return {
    error: sessionMutationError(reconciliation.error, "start that session"),
  };
}

function forkErrorState(error: unknown): Partial<SessionViewState> {
  return { error: sessionMutationError(error, "fork that session") };
}

function mutationOutcome(
  outcome: SessionCreationReconciliation | undefined,
  reconciliation: UnknownCreationReconciliation | UnknownForkReconciliation,
): Exclude<SessionCreationReconciliation, { status: "ambiguous" }> | undefined {
  return reconciliation.baseline.bounded &&
    (outcome?.status === "created" || outcome?.status === "not_created")
    ? outcome
    : undefined;
}

function creationState(
  state: SessionViewState,
  reconciliation: UnknownCreationReconciliation,
  outcome: SessionCreationReconciliation | undefined,
): Partial<SessionViewState> {
  if (!reconciliation.baseline.bounded) {
    return creationErrorState(reconciliation);
  }

  if (outcome?.status !== "created" && outcome?.status !== "not_created") {
    return creationErrorState(reconciliation);
  }
  if (
    outcome.status === "created" &&
    !creationMatchesDescriptor(outcome.detail, reconciliation.descriptor)
  ) {
    return creationErrorState(reconciliation);
  }
  const sessions = reconciledSessions(state, outcome.sessions);
  return outcome.status === "created"
    ? sessionDetailState({ ...state, sessions }, outcome.detail, {
        creating: false,
        draft: {
          ...state.draft,
          images: [],
          prompt: "",
        },
        error: sessionMutationError(reconciliation.error, "start that session"),
        loadingDetail: false,
        selectedId: outcome.detail.id,
      })
    : {
        creating: false,
        detail:
          selectedSessionId(state, sessions) === state.selectedId
            ? state.detail
            : undefined,
        error: sessionMutationError(reconciliation.error, "start that session"),
        loadingDetail: false,
        selectedId: selectedSessionId(state, sessions),
        sessions,
      };
}

function forkState(
  state: SessionViewState,
  outcome: SessionCreationReconciliation | undefined,
  reconciliation: UnknownForkReconciliation,
): Partial<SessionViewState> {
  const settled = mutationOutcome(outcome, reconciliation);
  if (settled === undefined) return forkErrorState(reconciliation.error);
  const sessions = reconciledSessions(state, settled.sessions);
  if (settled.status === "created") {
    return sessionDetailState({ ...state, sessions }, settled.detail, {
      error: undefined,
      followUp: "",
      followUpImages: [],
      forking: false,
      history: newestSessionHistoryState(settled.detail.hasOlderSegments),
      loadingDetail: false,
      selectedId: settled.detail.id,
      toolStreams: [],
    });
  }
  return {
    ...forkErrorState(reconciliation.error),
    forking: false,
    sessions,
  };
}

function detailState(
  state: SessionViewState,
  reconciliation: UnknownDetailReconciliation,
  detail: AgentSessionDetail | undefined,
): Partial<SessionViewState> {
  const { baseline, error, options } = reconciliation;
  const acknowledgement =
    detail === undefined
      ? { status: "uncertain" as const }
      : acknowledgeSessionMutation(state.detail, detail, options, baseline);
  if (acknowledgement.status !== "committed") {
    return { error: sessionMutationError(error, options.action) };
  }
  return sessionDetailState(state, acknowledgement.detail, {
    [options.pending]: false,
    ...options.success,
    error: sessionMutationError(error, options.action),
  });
}

function reconciliationSettled(
  reconciliation: UnknownMutationReconciliation,
  patch: Partial<SessionViewState>,
): boolean {
  return reconciliation.kind === "creation"
    ? patch.creating === false
    : reconciliation.kind === "fork"
      ? patch.forking === false
      : patch[reconciliation.options.pending] === false;
}

export interface SessionReconciliationController {
  readonly creation: (revision: number, error: unknown, baseline: ReadonlySet<string>, descriptor: SessionCreationDescriptor) => Promise<void>;
  readonly detail: (revision: number, error: unknown, options: DetailMutationOptions, baseline: AgentSessionDetail) => Promise<void>;
  readonly fork: (revision: number, error: unknown, baseline: ReadonlySet<string>) => Promise<void>;
  readonly reconnect: () => void;
  readonly reset: () => void;
}

export function createSessionReconciliationController(
  view: RevisionState<SessionViewState>, loader: SessionLoadController,
): SessionReconciliationController {
  const state: {
    activeGeneration: number | undefined; generation: number;
    pending: UnknownMutationReconciliation | undefined;
    reconnectGeneration: number; retryPending: boolean;
  } = { activeGeneration: undefined, generation: 0, pending: undefined,
    reconnectGeneration: 0, retryPending: false };
  const creation = async (
    revision: number,
    error: unknown,
    baseline: ReadonlySet<string>,
    descriptor: SessionCreationDescriptor,
  ): Promise<void> => {
    const retained = cappedSessionCreationIds(baseline);
    await start({
      baseline: retained,
      descriptor,
      error,
      kind: "creation",
      revision,
    });
  }

  const fork = async (
    revision: number,
    error: unknown,
    baseline: ReadonlySet<string>,
  ): Promise<void> => {
    await start({
      baseline: cappedSessionCreationIds(baseline),
      error,
      kind: "fork",
      revision,
    });
  }

  const detail = async (
    revision: number,
    error: unknown,
    options: DetailMutationOptions,
    baseline: AgentSessionDetail,
  ): Promise<void> => {
    await start({
      baseline,
      error,
      kind: "detail",
      options,
      revision,
    });
  }

  const start = async (reconciliation: UnknownMutationReconciliation): Promise<void> => {
    state.pending = reconciliation;
    await run(reconciliation);
  }

  const reconnect = (): void => {
    loader.hydrateAfterReconnect();
    state.reconnectGeneration += 1;
    const pending = state.pending;
    if (pending !== undefined) {
      if (state.activeGeneration === state.generation) {
        state.retryPending = true;
      } else {
        void run(pending);
      }
    }
  }

  const reset = (): void => {
    state.generation += 1;
    state.activeGeneration = undefined;
    state.pending = undefined;
    state.reconnectGeneration = 0;
    state.retryPending = false;
  }

  const run = async (reconciliation: UnknownMutationReconciliation): Promise<void> => {
    const generation = state.generation;
    const reconnectGeneration = state.reconnectGeneration;
    if (state.activeGeneration === generation) {
      return;
    }
    state.activeGeneration = generation;
    try {
      if (reconciliation.kind === "creation") {
        const outcome = await loader.reconcileSessions(
          reconciliation.baseline.ids,
        );
        settleCurrent(
          generation,
          reconnectGeneration,
          reconciliation,
          creationState(view.value, reconciliation, outcome),
        );
      } else if (reconciliation.kind === "fork") {
        const outcome = await loader.reconcileSessions(
          reconciliation.baseline.ids,
          "fork",
        );
        settleCurrent(
          generation,
          reconnectGeneration,
          reconciliation,
          forkState(view.value, outcome, reconciliation),
        );
      } else {
        const sessionId = reconciliation.options.payload["sessionId"];
        const detail =
          typeof sessionId === "string"
            ? await loader.reconcileDetail(sessionId)
            : undefined;
        settleCurrent(
          generation,
          reconnectGeneration,
          reconciliation,
          detailState(view.value, reconciliation, detail),
        );
      }
    } finally {
      if (generation === state.generation) {
        finish(generation);
      }
    }
  }

  const finish = (generation: number): void => {
    if (state.activeGeneration !== generation) {
      return;
    }
    state.activeGeneration = undefined;
    const pending = state.pending;
    if (state.retryPending && pending !== undefined) {
      state.retryPending = false;
      void run(pending);
    } else if (pending === undefined) {
      state.retryPending = false;
      loader.continueHydration();
    } else {
      state.retryPending = false;
    }
  }

  const settleCurrent = (
    generation: number,
    reconnectGeneration: number,
    reconciliation: UnknownMutationReconciliation,
    patch: Partial<SessionViewState>,
  ): void => {
    if (
      generation === state.generation &&
      reconnectGeneration === state.reconnectGeneration
    ) {
      settle(reconciliation, patch);
    }
  }

  const settle = (
    reconciliation: UnknownMutationReconciliation,
    patch: Partial<SessionViewState>,
  ): void => {
    if (state.pending !== reconciliation) {
      return;
    }
    const settled = reconciliationSettled(reconciliation, patch);
    const patched = view.patchCurrent(reconciliation.revision, patch);
    if (settled && patched) {
      state.pending = undefined;
    }
  }
  return { creation, detail, fork, reconnect, reset };
}
