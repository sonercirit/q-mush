import type { AgentSessionStatus } from "../shared/session-model.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionMutation } from "./session-mutations.ts";

export function selectedDetailHasStatus(
  state: SessionViewState,
  allowed: (status: AgentSessionStatus) => boolean,
): boolean {
  return (
    state.selectedId !== undefined &&
    state.detail?.id === state.selectedId &&
    allowed(state.detail.status)
  );
}

export function sessionIsActive(status: AgentSessionStatus): boolean {
  return status === "queued" || status === "running" || status === "paused";
}

export function sessionCanCompactAndContinue(
  status: AgentSessionStatus,
): boolean {
  return status === "idle";
}

export function sessionCanResume(status: AgentSessionStatus): boolean {
  return (
    status === "completed" ||
    status === "idle" ||
    status === "failed" ||
    status === "stopped"
  );
}

// Gates both compaction flags (auto and idle): the settings are durable
// per-session preferences, editable even on failed/stopped sessions where
// the idle timer stays inert until the session runs again.
export function sessionCanUpdateAutoCompaction(
  status: AgentSessionStatus,
): boolean {
  return sessionCanResume(status) || sessionIsActive(status);
}

export function selectedMutation(
  sessionId: string | undefined,
  create: (sessionId: string) => SessionMutation,
): SessionMutation | undefined {
  return sessionId === undefined ? undefined : create(sessionId);
}
