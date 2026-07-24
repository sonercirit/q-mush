import { type Accessor } from "solid-js";
import type {
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { listsMatchByIdentity, retainById } from "./collection-state.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";
import { compareSessionRecency } from "./session-summary-state.ts";

const ACTIVE_SESSION_DISPLAY_LIMIT = 4;

type RunningSessionsFreshness = "live" | "loading" | "stale";

export interface RunningSessionsViewState {
  readonly freshness: RunningSessionsFreshness;
  readonly overview: RunningSessionsOverview | undefined;
}

interface RunningSessionsOverview {
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
  const updatedAtDifference = compareSessionRecency(left, right);
  return statusDifference === 0 ? updatedAtDifference : statusDifference;
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

function deriveRunningSessions(
  sessions: readonly AgentSessionSummary[],
  limit = ACTIVE_SESSION_DISPLAY_LIMIT,
): RunningSessionsOverview {
  const active = sessions
    .filter(({ status }) => isActiveStatus(status))
    .toSorted(compareActiveSessions);
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

function retainedOverview(
  current: RunningSessionsOverview | undefined,
  sessions: readonly AgentSessionSummary[],
): RunningSessionsOverview {
  const incoming = deriveRunningSessions(sessions);
  return {
    ...incoming,
    visibleSessions: retainById(
      current?.visibleSessions,
      incoming.visibleSessions,
      panelSessionMatches,
    ),
  };
}

function overviewsMatch(
  left: RunningSessionsOverview | undefined,
  right: RunningSessionsOverview,
): boolean {
  return (
    left?.overflowCount === right.overflowCount &&
    left.queuedCount === right.queuedCount &&
    left.runningCount === right.runningCount &&
    listsMatchByIdentity(left.visibleSessions, right.visibleSessions)
  );
}

function initialRunningSessionsState(): RunningSessionsViewState {
  return { freshness: "loading", overview: undefined };
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

  applySnapshot(sessions: readonly AgentSessionSummary[]): void {
    const current = this.state;
    const overview = retainedOverview(current.overview, sessions);

    if (
      current.freshness !== "live" ||
      !overviewsMatch(current.overview, overview)
    ) {
      this.#reactive.setState({ freshness: "live", overview });
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
