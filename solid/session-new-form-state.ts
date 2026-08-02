import type { SessionViewState } from "./session-view-state.ts";

function projectNewSessionFormState(state: SessionViewState) {
  return {
    creating: state.creating,
    draft: state.draft,
    modelDiscovery: state.modelDiscovery,
    openSelect: state.openSelect,
    providerDiscovery: state.providerDiscovery,
  } as const;
}

export type NewSessionFormState = ReturnType<typeof projectNewSessionFormState>;

export function retainNewSessionFormState(
  state: SessionViewState,
  previous: NewSessionFormState | undefined,
): NewSessionFormState {
  const current = projectNewSessionFormState(state);
  if (
    previous !== undefined &&
    Object.entries(current).every(
      ([key, value]) =>
        Object.hasOwn(previous, key) && Reflect.get(previous, key) === value,
    )
  ) {
    return previous;
  }
  return current;
}
