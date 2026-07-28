import { Show, type JSX } from "solid-js";
import type { SessionForkSelection } from "../shared/session-fork.ts";
import { sessionCredentialSelectOptions } from "./session-credential-option.ts";
import { SessionEditorError } from "./session-editor-client.tsx";
import {
  createSessionForkModelEditor,
  type SessionModelDiscoveryProps,
} from "./session-fork-model-editor.ts";
import { parseModelCredentialValue } from "./session-model-options.ts";
import {
  SessionModelPickerFields,
  type SessionModelPickerSelection,
} from "./session-model-picker.tsx";

const SESSION_FORK_COMPACTION_WARNING =
  "The forked history will be compacted under the selected provider and model before you continue.";

type ForkDraft = SessionModelPickerSelection;

interface SessionForkEditorProps extends SessionModelDiscoveryProps {
  readonly messageId: string;
  readonly onCancel: () => void;
  readonly onFork: (
    messageId: string,
    selection?: SessionForkSelection,
  ) => Promise<void>;
}

function forkSelection(draft: ForkDraft): SessionForkSelection | undefined {
  const credential = parseModelCredentialValue(draft.credential);
  if (credential === undefined || draft.model.length === 0) return undefined;
  const reasoningEffort = draft.reasoningEffort;
  return {
    ...credential,
    model: draft.model,
    reasoningEffort:
      reasoningEffort === "none" ||
      reasoningEffort === "minimal" ||
      reasoningEffort === "low" ||
      reasoningEffort === "medium" ||
      reasoningEffort === "high" ||
      reasoningEffort === "xhigh" ||
      reasoningEffort === "max"
        ? reasoningEffort
        : null,
  };
}

function forkRequestSelection(
  detail: SessionModelDiscoveryProps["detail"],
  selection: SessionForkSelection,
): SessionForkSelection | undefined {
  return selection.credentialId === detail.credentialId &&
    selection.model === detail.model &&
    selection.provider === detail.provider &&
    (selection.reasoningEffort ?? null) === detail.reasoningEffort
    ? undefined
    : selection;
}

export function SessionForkEditor(props: SessionForkEditorProps): JSX.Element {
  const editor = createSessionForkModelEditor(props);
  const { catalog, draft, error, open, pending, setError, setPending } = editor;
  const differs = (): boolean => {
    const selected = forkSelection(draft());
    return (
      selected !== undefined &&
      (selected.provider !== props.detail.provider ||
        selected.model !== props.detail.model)
    );
  };
  const submit = async (): Promise<void> => {
    setError(undefined);
    const selected = forkSelection(draft());
    if (selected === undefined) {
      setError("Choose a model credential and model for the fork.");
      return;
    }
    setPending(true);
    try {
      await props.onFork(
        props.messageId,
        forkRequestSelection(props.detail, selected),
      );
      props.onCancel();
    } catch {
      setError("We could not fork that session. Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      aria-modal="true"
      class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
      role="dialog"
    >
      <div class="w-full max-w-xl rounded-3xl border border-cyan-300/20 bg-slate-900 p-6 shadow-2xl">
        <h3 class="text-xl font-semibold text-white">Fork session</h3>
        <p class="mt-2 text-sm leading-6 text-slate-400">
          Start from this message using the source provider and model, or choose
          a different configuration.
        </p>
        <div class="mt-5 grid gap-4 sm:grid-cols-2">
          <SessionModelPickerFields
            catalog={catalog()}
            credentialEmptyLabel="No model credentials"
            credentialOptions={sessionCredentialSelectOptions(
              props.credentials,
            )}
            disabled={pending()}
            idPrefix="session-fork"
            namePrefix="sessionFork"
            onChooseCredential={editor.chooseCredential}
            onChooseModel={editor.chooseModel}
            onChooseReasoning={editor.chooseReasoning}
            onToggle={editor.toggle}
            open={open()}
            selection={draft()}
          />
        </div>
        <Show when={differs()}>
          <p class="mt-4 rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-sm leading-6 text-amber-100">
            {SESSION_FORK_COMPACTION_WARNING}
          </p>
        </Show>
        <SessionEditorError message={error()} />
        <div class="mt-6 flex justify-end gap-3">
          <button
            class="rounded-xl border border-white/10 px-4 py-2 text-slate-200"
            disabled={pending()}
            onClick={() => {
              props.onCancel();
            }}
            type="button"
          >
            Cancel
          </button>
          <button
            class="rounded-xl bg-cyan-300 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50"
            data-session-fork-submit="true"
            disabled={pending() || forkSelection(draft()) === undefined}
            onClick={() => void submit()}
            type="button"
          >
            {pending() ? "Forking…" : "Fork session"}
          </button>
        </div>
      </div>
    </div>
  );
}
