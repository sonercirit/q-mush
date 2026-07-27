import { createSignal, type Accessor, type Setter } from "solid-js";
import type { ProviderCredential } from "./provider-client.tsx";

export interface SessionReassignmentDialogState {
  readonly credential: ProviderCredential;
  readonly error: string | undefined;
  readonly pending: boolean;
}

export class SessionReassignmentDialogController {
  readonly #readState: Accessor<SessionReassignmentDialogState | undefined>;
  readonly #writeState: Setter<SessionReassignmentDialogState | undefined>;

  constructor() {
    const [readState, writeState] = createSignal<
      SessionReassignmentDialogState | undefined
    >();
    this.#readState = readState;
    this.#writeState = writeState;
  }

  get state(): SessionReassignmentDialogState | undefined {
    return this.#readState();
  }

  open(credential: ProviderCredential): void {
    if (this.state?.pending !== true) {
      this.#replace({ credential, error: undefined, pending: false });
    }
  }

  close(): void {
    if (this.state?.pending !== true) {
      this.#replace(undefined);
    }
  }

  pending(): void {
    this.#update((state) => ({ ...state, error: undefined, pending: true }));
  }

  failed(error: string): void {
    this.#update((state) => ({ ...state, error, pending: false }));
  }

  succeeded(): void {
    this.#replace(undefined);
  }

  reset(): void {
    this.#replace(undefined);
  }

  #update(
    update: (
      state: SessionReassignmentDialogState,
    ) => SessionReassignmentDialogState,
  ): void {
    const state = this.state;
    if (state !== undefined) {
      this.#replace(update(state));
    }
  }

  #replace(state: SessionReassignmentDialogState | undefined): void {
    this.#writeState(() => state);
  }
}
