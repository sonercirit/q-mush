import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { expect, vi } from "vitest";

export function useFakeTestClock(disposals: (() => void)[]): void {
  vi.useFakeTimers({ shouldClearNativeTimers: true });
  disposals.push(vi.useRealTimers);
}

export function mountTestView(
  renderView: () => JSX.Element,
  disposals: (() => void)[],
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  disposals.push(render(renderView, container));
  return container;
}

export function queryTestElementAs<ElementType extends Element>(
  container: ParentNode,
  selector: string,
  constructor: abstract new (...arguments_: never[]) => ElementType,
): ElementType {
  const element = container.querySelector(selector);
  if (!(element instanceof constructor)) {
    throw new TypeError(`Missing test element: ${selector}`);
  }
  return element;
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

export function findTestButton(
  container: ParentNode,
  text: string,
): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    ({ textContent }) => textContent === text,
  );
}

export function clickTestButton(container: ParentNode, selector: string): void {
  const control = queryTestElement(container, selector);
  if (!(control instanceof HTMLButtonElement)) {
    throw new TypeError(`The test control ${selector} is not a button`);
  }
  control.click();
}

export function chooseTestOption(
  container: ParentNode,
  select: string,
  value: string,
): void {
  clickTestButton(container, select);
  clickTestButton(container, `[data-option-value='${value}']`);
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

export function setTestInputValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  element.value = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

export async function expectTestText(
  container: Node,
  text: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(container.textContent).toContain(text);
  });
}

export function disposeTestViews(disposals: (() => void)[]): void {
  for (const dispose of disposals.splice(0).reverse()) {
    dispose();
  }
  document.body.replaceChildren();
}
