export class RevisionState<State extends object> {
  readonly #onChange: () => void;
  #revision = 0;
  #value: State;

  constructor(initialValue: State, onChange: () => void) {
    this.#onChange = onChange;
    this.#value = initialValue;
  }

  get value(): State {
    return this.#value;
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
    this.#value = { ...this.#value, ...patch };
    this.#onChange();
  }

  patchCurrent(revision: number, patch: Partial<State>): boolean {
    if (!this.isCurrent(revision)) {
      return false;
    }

    this.patch(patch);
    return true;
  }

  replaceSilently(value: State): void {
    this.#value = value;
  }

  reset(value: State): void {
    this.#revision += 1;
    this.#value = value;
    this.#onChange();
  }
}
