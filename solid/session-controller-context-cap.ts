import {
  contextTokenCapMutation,
  type SessionMutation,
} from "./session-mutations.ts";
import { sessionMutationPending } from "./session-pending.ts";
import type { SessionViewState } from "./session-view-state.ts";

export async function setSessionContextTokenCap(
  state: SessionViewState,
  userContextTokenCap: number | null,
  compactIfExceeded: boolean,
  mutate: (mutation: SessionMutation) => Promise<void>,
  compact: () => Promise<void>,
): Promise<void> {
  const detail = state.detail;
  if (
    detail === undefined ||
    detail.id !== state.selectedId ||
    sessionMutationPending(state)
  )
    return;
  await mutate(contextTokenCapMutation(detail.id, userContextTokenCap));
  if (compactIfExceeded && detail.autoCompact && userContextTokenCap !== null) {
    await compact();
  }
}
