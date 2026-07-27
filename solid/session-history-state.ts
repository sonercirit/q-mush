import type { SessionHistoryPage } from "../shared/session-history.ts";

export interface SessionHistoryState {
  readonly canGoOlder: boolean;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly page: SessionHistoryPage | undefined;
}

export function initialSessionHistoryState(): SessionHistoryState {
  return {
    canGoOlder: false,
    error: undefined,
    loading: false,
    page: undefined,
  };
}

export function newestSessionHistoryState(
  hasOlderSegments: boolean,
): SessionHistoryState {
  return {
    canGoOlder: hasOlderSegments,
    error: undefined,
    loading: false,
    page: undefined,
  };
}
