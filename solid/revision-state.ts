import { type Accessor } from "solid-js";
import type { ReactiveState } from "./reactive-state.ts";

export function reactiveRevisionState<State extends object>(
  reactive: ReactiveState<State>,
): RevisionState<State> {
  return createRevisionState(reactive.state, reactive.setState);
}

export interface RevisionState<State extends object> {
  readonly accessor: Accessor<State>;
  readonly value: State;
  advance(): void;
  begin(patch?: Partial<State>): number;
  isCurrent(revision: number): boolean;
  patch(patch: Partial<State>): void;
  patchCurrent(revision: number, patch: Partial<State>): boolean;
  patchCurrentWith(revision: number, patch: () => Partial<State>): boolean;
  replaceSilently(value: State): void;
  reset(value: State): void;
}

export function createRevisionState<State extends object>(
  value: Accessor<State>,
  setState: ReactiveState<State>["setState"],
): RevisionState<State> {
  let revision = 0;
  const setValue = (next: State): void => {
    setState(() => next);
  };
  const state: RevisionState<State> = {
    accessor: value,
    get value() {
      return value();
    },
    advance() {
      revision += 1;
    },
    begin(patch) {
      state.advance();
      if (patch !== undefined) state.patch(patch);
      return revision;
    },
    isCurrent: (candidate) => candidate === revision,
    patch(patch) {
      setValue({ ...value(), ...patch });
    },
    patchCurrent(candidate, patch) {
      return state.patchCurrentWith(candidate, () => patch);
    },
    patchCurrentWith(candidate, patch) {
      if (!state.isCurrent(candidate)) return false;
      state.patch(patch());
      return true;
    },
    replaceSilently: setValue,
    reset(next) {
      state.advance();
      setValue(next);
    },
  };
  return state;
}
