import type { SessionViewState } from "../session-client.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

export function selectedSessionViewState(
  state: SessionViewState,
): SessionViewState {
  return {
    ...state,
    detail: TEST_SESSION_DETAIL,
    selectedId: TEST_SESSION_DETAIL.id,
    sessions: [TEST_SESSION_DETAIL],
  };
}
