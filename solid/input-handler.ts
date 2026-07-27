import type { JSX } from "solid-js";

export function checkedInputHandler(
  onChange: (checked: boolean) => void,
): JSX.EventHandler<HTMLInputElement, Event> {
  return (event) => {
    onChange(event.currentTarget.checked);
  };
}
