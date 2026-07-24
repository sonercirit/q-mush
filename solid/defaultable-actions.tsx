import { type JSX } from "solid-js";
import { DefaultControl, RemovalButton } from "./client-controls.tsx";

interface DefaultableActionsProps {
  readonly data?: Readonly<Record<string, string>>;
  readonly isDefault: boolean;
  readonly onRemove: () => void;
  readonly onSetDefault: () => void;
  readonly removing: boolean;
  readonly settingDefault: boolean;
}

export function DefaultableActions(
  props: DefaultableActionsProps,
): JSX.Element {
  const data = (): { readonly data?: Readonly<Record<string, string>> } =>
    props.data === undefined ? {} : { data: props.data };

  return (
    <div class="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto md:shrink-0">
      <DefaultControl
        {...data()}
        idleLabel="Make default"
        isDefault={props.isDefault}
        onClick={props.onSetDefault}
        pending={props.settingDefault}
        pendingLabel="Setting…"
      />
      <RemovalButton
        {...data()}
        onClick={props.onRemove}
        pending={props.removing}
      />
    </div>
  );
}
