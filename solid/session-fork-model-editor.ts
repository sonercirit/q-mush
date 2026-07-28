import { createEffect, on, untrack, type Accessor } from "solid-js";
import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

import {
  createSessionModelPickerState,
  initialSessionModelPickerSelection,
  type SessionModelPickerSelection,
  type SessionModelPickerSelectionProps,
} from "./session-model-picker.tsx";

export interface SessionModelDiscoveryProps extends SessionModelPickerSelectionProps {
  readonly detail: AgentSessionDetail;
}

export interface SessionForkModelEditor {
  readonly catalog: Accessor<AgentModelCatalog | undefined>;
  readonly draft: Accessor<SessionModelPickerSelection>;
  readonly error: Accessor<string | undefined>;
  readonly open: Accessor<"credential" | "model" | "reasoning" | undefined>;
  readonly patch: (values: Partial<SessionModelPickerSelection>) => void;
  readonly pending: Accessor<boolean>;
  readonly setError: (value: string | undefined) => void;
  readonly setPending: (value: boolean) => void;
  readonly chooseCredential: (credential: string) => void;
  readonly chooseModel: (model: string) => void;
  readonly chooseReasoning: (reasoningEffort: string) => void;
  readonly toggle: (name: "credential" | "model" | "reasoning") => void;
}

export function createSessionForkModelEditor(
  props: SessionModelDiscoveryProps,
): SessionForkModelEditor {
  const initial = untrack(() =>
    initialSessionModelPickerSelection(props.detail),
  );
  const state = createSessionModelPickerState(initial, props);
  const { draft, editor, open, request, setDraft, setOpen } = state;
  const discover = editor.discover;
  let discoveredIdentity: string | undefined;
  createEffect(
    on(
      () =>
        `${props.detail.provider}:${props.detail.credentialId}:${props.detail.model}`,
      (identity) => {
        if (identity === discoveredIdentity) return;
        discoveredIdentity = identity;
        const selection = initialSessionModelPickerSelection(props.detail);
        setDraft(selection);
        request.setError(undefined);
        void discover(selection.credential);
      },
    ),
  );
  return {
    catalog: editor.catalog,
    chooseCredential: editor.actions.choose.credential,
    chooseModel: editor.actions.choose.model,
    chooseReasoning: editor.actions.choose.reasoning,
    draft,
    error: request.error,
    open,
    patch: editor.patch,
    pending: request.pending,
    setError: request.setError,
    setPending: request.setPending,
    toggle: (name) => {
      setOpen(open() === name ? undefined : name);
    },
  };
}
