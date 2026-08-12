import { type JSX } from "solid-js";
import { afterEach } from "vitest";
import { createNestedScrollRef } from "../nested-scroll.ts";
import { defineElementSize } from "./element-size-test-helpers.ts";

export function trackedDisposals(): (() => void)[] {
  const disposals: (() => void)[] = [];
  afterEach(() => {
    for (;;) {
      const dispose = disposals.pop();
      if (dispose === undefined) return;
      dispose();
    }
  });
  return disposals;
}

export function mutationTestPane(props: {
  readonly id: string;
  readonly label: string;
}): JSX.Element {
  const nestedScrollRef = createNestedScrollRef(() => props.id);
  return (
    <section data-mutation-pane-scope={props.label} ref={nestedScrollRef}>
      <div
        class="overflow-auto"
        data-mutation-pane={props.label}
        data-line-wrap="true"
      />
    </section>
  );
}

export function queryMutationPane(
  container: ParentNode,
  label: string,
): HTMLElement {
  const pane = container.querySelector(`[data-mutation-pane='${label}']`);
  if (!(pane instanceof HTMLElement))
    throw new TypeError(`Missing ${label} mutation pane`);
  return pane;
}

export function rememberPane(
  pane: HTMLElement,
  top: number,
  toggle?: HTMLButtonElement,
): void {
  defineElementSize(pane, 100, 1_000);
  toggle?.click();
  pane.scrollTop = top;
  pane.dispatchEvent(new Event("scroll", { bubbles: true }));
}
