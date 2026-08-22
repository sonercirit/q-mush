import type { JSX } from "solid-js";

function Label(props: { readonly text: string }): JSX.Element {
  return <span>{props.text}</span>;
}

function BrokenLabel(props: { readonly text: string }): JSX.Element {
  const snapshot = { ...props };
  const text = props.text;
  return <Label {...snapshot} text={text} />;
}

console.log(BrokenLabel);
