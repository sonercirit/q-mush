import type { JSX } from "solid-js";

export function FormField(props: {
  readonly control: JSX.Element;
  readonly id: string;
  readonly label: JSX.Element;
}): JSX.Element {
  return (
    <div>
      <label class="text-sm font-medium text-slate-200" for={props.id}>
        {props.label}
      </label>
      {props.control}
    </div>
  );
}

export function renderFormField(
  id: string,
  label: JSX.Element,
  control: JSX.Element,
): JSX.Element {
  return <FormField control={control} id={id} label={label} />;
}
