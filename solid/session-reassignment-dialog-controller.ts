import { createSignal } from "solid-js";
import type { ProviderCredential } from "./provider-credential-model.ts";

interface SessionReassignmentDialogState {
  readonly credential: ProviderCredential;
  readonly error: string | undefined;
  readonly pending: boolean;
}

export interface SessionReassignmentDialogController {
  readonly state: SessionReassignmentDialogState | undefined;
  open(credential: ProviderCredential): void;
  close(): void;
  pending(): void;
  failed(error: string): void;
  succeeded(): void;
  reset(): void;
}

export function createSessionReassignmentDialogController(): SessionReassignmentDialogController {
  const [readState, writeState] = createSignal<
    SessionReassignmentDialogState | undefined
  >();
  const replace = (state: SessionReassignmentDialogState | undefined): void => {
    writeState(() => state);
  };
  const update = (
    operation: (
      state: SessionReassignmentDialogState,
    ) => SessionReassignmentDialogState,
  ): void => {
    const state = readState();
    if (state !== undefined) {
      replace(operation(state));
    }
  };
  return {
    get state() {
      return readState();
    },
    open: (credential) => {
      if (readState()?.pending !== true) {
        replace({ credential, error: undefined, pending: false });
      }
    },
    close: () => {
      if (readState()?.pending !== true) {
        replace(undefined);
      }
    },
    pending: () => {
      update((state) => ({ ...state, error: undefined, pending: true }));
    },
    failed: (error) => {
      update((state) => ({ ...state, error, pending: false }));
    },
    succeeded: () => {
      replace(undefined);
    },
    reset: () => {
      replace(undefined);
    },
  };
}
