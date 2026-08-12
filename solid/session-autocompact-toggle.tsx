import type { JSX } from "solid-js";

export type SessionCompactionFlag = "autoCompact" | "idleCompact";

const COMPACTION_TOGGLES: Readonly<
  Record<SessionCompactionFlag, { readonly id: string; readonly label: string }>
> = {
  autoCompact: {
    id: "session-auto-compact",
    label: "Compact automatically near the context limit",
  },
  idleCompact: {
    id: "session-idle-compact",
    label: "Compact 30 minutes after the agent finishes",
  },
};

export function SessionCompactionToggle(props: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly flag: SessionCompactionFlag;
  readonly onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label class="flex min-h-11 items-center gap-2 text-sm text-slate-300 md:col-span-2">
      <input
        checked={props.checked}
        disabled={props.disabled}
        id={COMPACTION_TOGGLES[props.flag].id}
        name={props.flag}
        onChange={(event) => {
          const selected = event.currentTarget.checked;
          props.onChange(selected);
        }}
        type="checkbox"
      />
      {COMPACTION_TOGGLES[props.flag].label}
    </label>
  );
}

export function SessionDraftCompactionToggles(props: {
  readonly autoCompact: boolean;
  readonly disabled: boolean;
  readonly idleCompact: boolean;
  readonly onChange: (flag: SessionCompactionFlag, checked: boolean) => void;
}): JSX.Element {
  return (
    <>
      <SessionCompactionToggle
        checked={props.autoCompact}
        disabled={props.disabled}
        flag="autoCompact"
        onChange={(checked) => {
          props.onChange("autoCompact", checked);
        }}
      />
      <SessionCompactionToggle
        checked={props.idleCompact}
        disabled={props.disabled}
        flag="idleCompact"
        onChange={(checked) => {
          props.onChange("idleCompact", checked);
        }}
      />
    </>
  );
}
