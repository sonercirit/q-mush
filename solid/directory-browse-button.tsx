import type { JSX } from "solid-js";

export function DirectoryBrowseButton(props: {
  readonly class: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  const body = { class: props.class, disabled: props.disabled };
  const onClick = (): void => {
    props.onClick();
  };
  return (
    <button {...body} onClick={onClick} type="button">
      Browse
    </button>
  );
}
