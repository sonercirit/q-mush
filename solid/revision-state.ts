import { type Accessor } from "solid-js";
import type { ReactiveState } from "./reactive-state.ts";

export function reactiveRevisionState<State extends object>(
  reactive: ReactiveState<State>,
): RevisionState<State> {
  return new RevisionState(reactive.state, reactive.setState);
}

export class RevisionState<State extends object> {
  #revision = 0;
  readonly #setValue: (value: State) => void;
  readonly #value: Accessor<State>;

  constructor(
    value: Accessor<State>,
    setValue: ReactiveState<State>["setState"],
  ) {
    this.#setValue = (next) => {
      setValue(() => next);
    };
    this.#value = value;
  }

  get value(): State {
    return this.#value();
  }

  get accessor(): Accessor<State> {
    return this.#value;
  }

  advance(): void {
    this.#revision += 1;
  }

  begin(patch?: Partial<State>): number {
    this.advance();

    if (patch !== undefined) {
      this.patch(patch);
    }

    return this.#revision;
  }

  isCurrent(revision: number): boolean {
    return revision === this.#revision;
  }

  patch(patch: Partial<State>): void {
    this.#setValue({ ...this.value, ...patch });
  }

  patchCurrent(revision: number, patch: Partial<State>): boolean {
    return this.patchCurrentWith(revision, () => patch);
  }

  patchCurrentWith(revision: number, patch: () => Partial<State>): boolean {
    if (!this.isCurrent(revision)) {
      return false;
    }

    this.patch(patch());
    return true;
  }

  replaceSilently(value: State): void {
    this.#setValue(value);
  }

  reset(value: State): void {
    this.advance();
    this.#setValue(value);
  }
}
