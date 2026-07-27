import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { newestSessionHistoryState } from "./session-history-state.ts";

export function showNewestSessionHistory(
  view: RevisionState<SessionViewState>,
  hasOlderSegments: boolean,
): void {
  view.patch({ history: newestSessionHistoryState(hasOlderSegments) });
}

export function applyWhenViewingNewestHistory(
  view: RevisionState<SessionViewState>,
  apply: () => void,
): void {
  if (view.value.history.page === undefined) {
    apply();
  }
}
