import type { JSX } from "solid-js";
import { checkedInputHandler } from "./input-handler.ts";

export function SessionAutoCompactToggle(props: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label class="flex min-h-11 items-center gap-2 text-sm text-slate-300 md:col-span-2">
      <input
        checked={props.checked}
        disabled={props.disabled}
        id="session-auto-compact"
        name="autoCompact"
        onChange={checkedInputHandler(props.onChange)}
        type="checkbox"
      />
      Compact automatically near the context limit
    </label>
  );
}
