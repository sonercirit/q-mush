import type { SessionViewState } from "./session-client.tsx";

export function sessionDetailMutationPending(state: SessionViewState): boolean {
  return (
    state.compacting || state.reassigning || state.sending || state.stopping
  );
}

export function sessionMutationPending(state: SessionViewState): boolean {
  return state.creating || sessionDetailMutationPending(state);
}
