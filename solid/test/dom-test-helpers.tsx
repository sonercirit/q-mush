import { type JSX } from "solid-js";
import { render } from "solid-js/web";

export function mountTestView(
  renderView: () => JSX.Element,
  disposals: (() => void)[],
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  disposals.push(render(renderView, container));
  return container;
}
