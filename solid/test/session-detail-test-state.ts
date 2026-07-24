import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../../shared/session-model.ts";
import { createReactiveState, type ReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../session-transcript-filters.ts";

export function sessionDetailState(
  detail: AgentSessionDetail,
  sessions?: readonly AgentSessionSummary[],
): ReactiveState<SessionViewState> {
  const transcriptFilters = { ...DEFAULT_SESSION_TRANSCRIPT_FILTERS };
  return createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    detail,
    selectedId: detail.id,
    transcriptFilters: {
      ...transcriptFilters,
      systemPrompt: true,
      thinking: true,
      toolDefinitions: true,
    },
    ...(sessions === undefined ? {} : { sessions }),
  });
}
