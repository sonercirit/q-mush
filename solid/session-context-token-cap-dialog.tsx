import { type JSX } from "solid-js";
import { ConfirmationDialog } from "./confirmation-dialog.tsx";
import { formatTokenCount } from "./session-context-client.tsx";

export function SessionContextTokenCapDialog(props: {
  readonly cap: number | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: (cap: number) => void;
  readonly returnFocus: () => HTMLElement | undefined;
}): JSX.Element {
  const cap = (): number => props.cap ?? 0;
  return (
    <ConfirmationDialog
      dataAttribute="true"
      description={
        <>
          Current context usage already exceeds this cap. Automatic compaction
          will trigger first when enabled.
        </>
      }
      id="session-context-cap-dialog"
      kicker="Context limit exceeded"
      onCancel={props.onCancel}
      open={props.cap !== undefined}
      returnFocus={props.returnFocus}
      title={<>Apply a {formatTokenCount(cap())} token cap?</>}
    >
      <button
        class="min-h-11 rounded-xl bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950"
        onClick={() => {
          props.onConfirm(cap());
        }}
        type="button"
      >
        Apply cap
      </button>
    </ConfirmationDialog>
  );
}
