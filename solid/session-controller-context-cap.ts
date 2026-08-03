import { sessionCanResume } from "./session-controller-guards.ts";
import {
  contextTokenCapMutation,
  type SessionMutation,
} from "./session-mutations.ts";
import type { SessionViewState } from "./session-view-state.ts";

export async function setSessionContextTokenCap(
  readState: () => Pick<SessionViewState, "detail" | "selectedId">,
  userContextTokenCap: number | null,
  compactIfExceeded: boolean,
  mutate: (mutation: SessionMutation) => Promise<void>,
  compact: () => Promise<void>,
): Promise<void> {
  const initial = readState();
  const detail = initial.detail;
  if (detail === undefined || detail.id !== initial.selectedId) return;
  await mutate(contextTokenCapMutation(detail.id, userContextTokenCap));
  const acknowledgedState = readState();
  const acknowledged = acknowledgedState.detail;
  if (
    compactIfExceeded &&
    userContextTokenCap !== null &&
    acknowledged !== undefined &&
    acknowledged.id === acknowledgedState.selectedId &&
    acknowledged.userContextTokenCap === userContextTokenCap &&
    acknowledged.autoCompact &&
    acknowledged.currentContextTokens > userContextTokenCap &&
    sessionCanResume(acknowledged.status)
  ) {
    await compact();
  }
}
