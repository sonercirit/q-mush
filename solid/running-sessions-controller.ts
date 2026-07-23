import { type Accessor } from "solid-js";
import type {
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { listsMatchByIdentity, retainById } from "./collection-state.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";

const ACTIVE_SESSION_DISPLAY_LIMIT = 4;

type RunningSessionsFreshness = "live" | "loading" | "stale";

export interface RunningSessionsViewState {
  readonly freshness: RunningSessionsFreshness;
  readonly sessions: readonly AgentSessionSummary[] | undefined;
}

export interface RunningSessionsOverview {
  readonly overflowCount: number;
  readonly queuedCount: number;
  readonly runningCount: number;
  readonly visibleSessions: readonly AgentSessionSummary[];
}

function isActiveStatus(status: AgentSessionStatus): boolean {
  return status === "queued" || status === "running";
}

function statusOrder(status: AgentSessionStatus): number {
  return status === "running" ? 0 : 1;
}

function compareActiveSessions(
  left: AgentSessionSummary,
  right: AgentSessionSummary,
): number {
  const statusDifference = statusOrder(left.status) - statusOrder(right.status);
  return statusDifference === 0
    ? right.updatedAt - left.updatedAt
    : statusDifference;
}

function activeSessions(
  sessions: readonly AgentSessionSummary[],
): readonly AgentSessionSummary[] {
  return sessions.filter(({ status }) => isActiveStatus(status));
}

function panelSessionMatches(
  left: AgentSessionSummary,
  right: AgentSessionSummary,
): boolean {
  return (
    left.id === right.id &&
    left.activeDurationMs === right.activeDurationMs &&
    left.activeStartedAt === right.activeStartedAt &&
    left.createdAt === right.createdAt &&
    left.model === right.model &&
    left.provider === right.provider &&
    left.runnerId === right.runnerId &&
    left.status === right.status &&
    left.title === right.title &&
    (left.status === "running" || left.updatedAt === right.updatedAt)
  );
}

function retainPanelSessions(
  current: readonly AgentSessionSummary[] | undefined,
  incoming: readonly AgentSessionSummary[],
): readonly AgentSessionSummary[] {
  const retained = retainById(
    current,
    activeSessions(incoming),
    panelSessionMatches,
  );
  return retained.length < 2
    ? retained
    : [...retained].sort(compareActiveSessions);
}

function sessionListsMatch(
  left: readonly AgentSessionSummary[] | undefined,
  right: readonly AgentSessionSummary[],
): boolean {
  return listsMatchByIdentity(left, right);
}

export function deriveRunningSessions(
  sessions: readonly AgentSessionSummary[],
  limit = ACTIVE_SESSION_DISPLAY_LIMIT,
): RunningSessionsOverview {
  const active = [...activeSessions(sessions)].sort(compareActiveSessions);
  const runningCount = active.filter(
    ({ status }) => status === "running",
  ).length;
  const queuedCount = active.length - runningCount;
  const visibleSessions = active.slice(0, Math.max(0, limit));
  return {
    overflowCount: active.length - visibleSessions.length,
    queuedCount,
    runningCount,
    visibleSessions,
  };
}

function initialRunningSessionsState(): RunningSessionsViewState {
  return { freshness: "loading", sessions: undefined };
}

export class RunningSessionsController {
  readonly #reactive: ReactiveState<RunningSessionsViewState>;

  constructor(initialState = initialRunningSessionsState()) {
    this.#reactive = createReactiveState(initialState);
  }

  get state(): RunningSessionsViewState {
    return this.#reactive.state();
  }

  get view(): Accessor<RunningSessionsViewState> {
    return this.#reactive.state;
  }

  applyDelta(): void {
    // Streaming text cannot affect active-session status or counts.
  }

  #replaceSessions(
    current: RunningSessionsViewState,
    sessions: readonly AgentSessionSummary[],
  ): void {
    if (!sessionListsMatch(current.sessions, sessions)) {
      this.#reactive.setState({ ...current, sessions });
    }
  }

  applySession(session: AgentSessionSummary): void {
    const current = this.state;
    if (current.sessions === undefined) {
      return;
    }
    const sessions = retainPanelSessions(current.sessions, [
      ...current.sessions.filter(({ id }) => id !== session.id),
      session,
    ]);

    this.#replaceSessions(current, sessions);
  }

  applySnapshot(sessions: readonly AgentSessionSummary[]): void {
    const current = this.state;
    const retained = retainPanelSessions(current.sessions, sessions);

    if (
      current.freshness !== "live" ||
      !sessionListsMatch(current.sessions, retained)
    ) {
      this.#reactive.setState({ freshness: "live", sessions: retained });
    }
  }

  connectionLost(): void {
    const current = this.state;
    if (current.freshness !== "stale") {
      this.#reactive.setState({ ...current, freshness: "stale" });
    }
  }

  reset(): void {
    this.#reactive.setState(initialRunningSessionsState());
  }
}
