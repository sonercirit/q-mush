import type { JSX } from "solid-js";

export function DirectoryBrowseButton(props: {
  readonly class: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      class={props.class}
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      Browse
    </button>
  );
}
