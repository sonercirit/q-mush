import {
  renderDefaultControl,
  renderRemovalButton,
} from "./client-controls.tsx";
import { createElement, type JsxNode } from "./jsx.ts";

interface DefaultableActions {
  readonly defaultAction: string;
  readonly id: string;
  readonly idAttribute: string;
  readonly isDefault: boolean;
  readonly removeAction: string;
  readonly removing: boolean;
  readonly settingDefault: boolean;
}

export function renderDefaultableActions(options: DefaultableActions): JsxNode {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {renderDefaultControl({
        action: options.defaultAction,
        dataAttribute: options.idAttribute,
        id: options.id,
        isDefault: options.isDefault,
        pending: options.settingDefault,
      })}
      {renderRemovalButton({
        action: options.removeAction,
        dataAttribute: options.idAttribute,
        id: options.id,
        pending: options.removing,
      })}
    </div>
  );
}
