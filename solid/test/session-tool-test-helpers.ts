import { expect } from "vitest";
import { clickTestButton } from "./dom-test-helpers.ts";

export function expectNoToolLimitsNote(container: ParentNode): void {
  expect(container.querySelector("[data-tool-limits-note='true']")).toBeNull();
}

export function expectConfiguredBashMaximum(container: ParentNode): void {
  clickTestButton(container, "[data-tool-details='bash']");
  expect(
    container.querySelector("[data-tool-detail-panel='bash']")?.textContent,
  ).toContain("420");
}
