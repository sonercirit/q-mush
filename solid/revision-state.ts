import { type Accessor } from "solid-js";

export class RevisionState<State extends object> {
  #revision = 0;
  readonly #setValue: (value: State) => void;
  readonly #value: Accessor<State>;

  constructor(value: Accessor<State>, setValue: (value: State) => void) {
    this.#setValue = setValue;
    this.#value = value;
  }

  get value(): State {
    return this.#value();
  }

  begin(patch?: Partial<State>): number {
    this.#revision += 1;

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
    if (!this.isCurrent(revision)) {
      return false;
    }

    this.patch(patch);
    return true;
  }

  replaceSilently(value: State): void {
    this.#setValue(value);
  }

  reset(value: State): void {
    this.#revision += 1;
    this.#setValue(value);
  }
}
