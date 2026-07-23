import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../../shared/session-model.ts";
import { createReactiveState, type ReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { initialSessionViewState } from "../session-state.ts";

export function sessionDetailState(
  detail: AgentSessionDetail,
  sessions?: readonly AgentSessionSummary[],
): ReactiveState<SessionViewState> {
  return createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    detail,
    selectedId: detail.id,
    ...(sessions === undefined ? {} : { sessions }),
  });
}
