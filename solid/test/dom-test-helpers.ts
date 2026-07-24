import type { JSX } from "solid-js";
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

export function queryTestElement(
  container: ParentNode,
  selector: string,
): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`The test element ${selector} was not rendered`);
  }
  return element;
}

export function clickTestButton(container: ParentNode, selector: string): void {
  const control = queryTestElement(container, selector);
  if (!(control instanceof HTMLButtonElement)) {
    throw new TypeError(`The test control ${selector} is not a button`);
  }
  control.click();
}

export function queryTestTranscript(container: ParentNode): HTMLUListElement {
  const element = queryTestElement(
    container,
    "[data-session-transcript='true']",
  );
  if (!(element instanceof HTMLUListElement)) {
    throw new TypeError("The session transcript is not a list");
  }
  return element;
}

export function disposeTestViews(disposals: (() => void)[]): void {
  for (const dispose of disposals.splice(0).reverse()) {
    dispose();
  }
  document.body.replaceChildren();
}
