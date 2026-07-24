import type { RevisionState } from "./revision-state.ts";

interface DiscoveryCallbacks<State, Catalog> {
  readonly accept: (catalog: Catalog) => void;
  readonly active: (state: State) => boolean;
  readonly failed: () => void;
  readonly load: () => Promise<Catalog>;
  readonly started: () => void;
}

export abstract class DiscoveryController<State extends object, Catalog> {
  readonly #catalogs = new Map<string, Catalog>();
  #request = 0;
  protected readonly state: RevisionState<State>;

  constructor(state: RevisionState<State>) {
    this.state = state;
  }

  protected discover(
    key: string,
    force: boolean,
    callbacks: DiscoveryCallbacks<State, Catalog>,
  ): void {
    const cached = force ? undefined : this.#catalogs.get(key);
    if (cached !== undefined) {
      callbacks.accept(cached);
      return;
    }

    const request = (this.#request += 1);
    callbacks.started();
    void this.#load(key, request, callbacks);
  }

  protected invalidate(): void {
    this.#request += 1;
  }

  reset(): void {
    this.#catalogs.clear();
    this.invalidate();
  }

  protected fresh(
    force: boolean,
    matches: boolean,
    loading: boolean,
    catalog: unknown,
  ): boolean {
    return force || !matches || (!loading && catalog === undefined);
  }

  async #load(
    key: string,
    request: number,
    callbacks: DiscoveryCallbacks<State, Catalog>,
  ): Promise<void> {
    try {
      const catalog = await callbacks.load();
      if (request !== this.#request || !callbacks.active(this.state.value)) {
        return;
      }

      this.#catalogs.set(key, catalog);
      callbacks.accept(catalog);
    } catch {
      if (request === this.#request && callbacks.active(this.state.value)) {
        callbacks.failed();
      }
    }
  }
}
