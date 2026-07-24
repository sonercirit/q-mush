import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import type {
  SessionDraft,
  SessionViewState,
} from "../../solid/session-client.tsx";
import { initialSessionViewState } from "../../solid/session-state.ts";

export function sessionViewWithDraft(
  draft: Partial<SessionDraft>,
): SessionViewState {
  const initial = initialSessionViewState();
  return {
    ...initial,
    draft: Object.assign({}, initial.draft, draft),
  };
}

export function discoveredSessionState(
  credential: string,
  catalog: AgentModelCatalog,
  draft: Partial<SessionDraft> = {},
  overrides: Partial<SessionViewState> = {},
): SessionViewState {
  const base = sessionViewWithDraft({
    credential,
    model: catalog.defaultModel ?? "",
    ...draft,
  });
  return {
    ...base,
    modelDiscovery: {
      catalog,
      credential,
      error: undefined,
      loading: false,
    },
    sessions: [],
    ...overrides,
  };
}
