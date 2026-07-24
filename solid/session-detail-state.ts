import type { SessionViewState } from "./session-client.tsx";
import {
  replaceSessionSummary,
  retainUnchangedSessionData,
} from "./session-controller-state.ts";

export function sessionDetailState(
  state: SessionViewState,
  detail: NonNullable<SessionViewState["detail"]>,
  extra: Partial<SessionViewState>,
): Partial<SessionViewState> {
  const visibleDetail = retainUnchangedSessionData(state.detail, detail);
  return {
    detail: visibleDetail,
    sessions: replaceSessionSummary(state.sessions ?? [], visibleDetail),
    ...extra,
  };
}
