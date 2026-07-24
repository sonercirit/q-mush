import type { JSX } from "solid-js";
import { render } from "solid-js/web";

export interface MountedDomView {
  readonly container: HTMLDivElement;
  readonly dispose: () => void;
}

export function mountDomView(renderView: () => JSX.Element): MountedDomView {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, dispose: render(renderView, container) };
}
