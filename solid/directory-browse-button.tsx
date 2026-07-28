import type { JSX } from "solid-js";

export function DirectoryBrowseButton(props: {
  readonly class: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  const onClick = (): void => {
    props.onClick();
  };
  return (
    <button
      class={props.class}
      disabled={props.disabled}
      onClick={onClick}
      type="button"
    >
      Browse
    </button>
  );
}
