import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { SessionQuestionActionDependencies } from "./session-question-actions.ts";
import type { SessionRuntimes } from "./session-runtime.ts";

export type RunnerAvailabilityParameters = readonly [
  userId: string,
  runnerId: string,
  now: number,
  workspaceId: string | undefined,
];

interface RunnerAvailabilityStore {
  readonly available: (parameters: RunnerAvailabilityParameters) => boolean;
}

export function runnerAvailabilityAt(
  store: RunnerAvailabilityStore,
  now: () => number,
): SessionRunnerAvailability {
  return (userId, runnerId, workspaceId) =>
    store.available([userId, runnerId, now(), workspaceId]);
}

export type SessionRunnerAvailability = (
  userId: string,
  runnerId: string,
  workspaceId?: string,
) => boolean;

export interface SessionQuestionLaunchBoundary {
  readonly questions: SessionQuestionActionDependencies;
  readonly runnerIsAvailable: SessionRunnerAvailability;
  readonly runtimes: Pick<SessionRuntimes, "settled">;
}

export function sessionRunnerIsAvailable(
  runnerIsAvailable: SessionRunnerAvailability,
  userId: string,
  detail: Pick<AgentSessionDetail, "runnerId" | "workspaceId">,
): boolean {
  return runnerIsAvailable(userId, detail.runnerId, detail.workspaceId);
}
