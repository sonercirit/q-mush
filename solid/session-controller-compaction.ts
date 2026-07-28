import type { AgentSessionStatus } from "../shared/session-model.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import {
  selectedDetailHasStatus,
  sessionCanCompactAndContinue,
  sessionCanResume,
  sessionCanUpdateAutoCompaction,
} from "./session-controller-guards.ts";
import type { DetailMutationOptions } from "./session-controller-reconciliation.ts";
import {
  compactionModeMutation,
  compactSessionMutation,
  type SessionMutation,
} from "./session-mutations.ts";
import { sessionMutationPending } from "./session-pending.ts";

export function compactSessionFromView(
  mutate: (
    mutation: (sessionId: string) => SessionMutation,
    allowed: (status: AgentSessionStatus) => boolean,
  ) => Promise<void>,
  continueAfter: boolean,
): Promise<void> {
  return mutate(
    (sessionId) => compactSessionMutation(sessionId, continueAfter),
    continueAfter ? sessionCanCompactAndContinue : sessionCanResume,
  );
}

export async function toggleSessionAutoCompaction(options: {
  readonly autoCompact: boolean;
  readonly mutate: (mutation: DetailMutationOptions) => Promise<void>;
  readonly view: RevisionState<SessionViewState>;
}): Promise<void> {
  const sessionId = options.view.value.selectedId;
  if (
    sessionId === undefined ||
    options.view.value.detail?.runnerRequired === true ||
    sessionMutationPending(options.view.value) ||
    !selectedDetailHasStatus(options.view.value, sessionCanUpdateAutoCompaction)
  ) {
    return;
  }
  await options.mutate(compactionModeMutation(sessionId, options.autoCompact));
}
