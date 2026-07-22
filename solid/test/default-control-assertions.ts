import { expect } from "vitest";

export function expectDefaultControls(
  html: string,
  action: string,
  idAttribute: string,
  id: string,
): void {
  void action;
  expect(html).toContain("Default");
  expect(html).toContain(`${idAttribute}="${id}"`);
  expect(html).toContain("Make default");
}
