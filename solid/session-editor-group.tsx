import { type JSX } from "solid-js";

const SESSION_EDITOR_GROUP_CLASSES =
  "mt-3 divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/[0.03]";

export function SessionEditorGroup(props: {
  readonly cap: JSX.Element;
  readonly provider: JSX.Element;
  readonly tools: JSX.Element;
}): JSX.Element {
  return (
    <div class={SESSION_EDITOR_GROUP_CLASSES} data-session-editor-group="true">
      <div class="contents">{props.provider}</div>
      <div class="contents">{props.cap}</div>
      <div class="contents">{props.tools}</div>
    </div>
  );
}
