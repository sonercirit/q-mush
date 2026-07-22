import { type JSX } from "solid-js";
import { NoHydration, renderToString } from "solid-js/web";

export function renderSolidToString(render: () => JSX.Element): string {
  return renderToString(() => <NoHydration>{render()}</NoHydration>);
}
