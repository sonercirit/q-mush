import { createSignal, type Accessor, type Setter } from "solid-js";

export interface ReactiveState<State> {
  readonly setState: Setter<State>;
  readonly state: Accessor<State>;
}

export function createReactiveState<State>(
  initialState: State,
): ReactiveState<State> {
  const [state, setState] = createSignal(initialState);
  return { setState, state };
}
