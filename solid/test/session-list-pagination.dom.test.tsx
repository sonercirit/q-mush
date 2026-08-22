import { expect, test } from "vitest";
import {
  mountedSessionList,
  parentSession,
  query,
  relatedChildren,
} from "./fine-grained-reactivity.dom.test.tsx";

test("loads the next child page without changing the root page", () => {
  const roots = Array.from({ length: 14 }, (_, index) => ({
    ...parentSession(),
    id: `root-${String(index + 1)}`,
    title: `Root ${String(index + 1)}`,
  }));
  const parent = roots[0];
  if (parent === undefined) throw new TypeError("Missing parent");
  const { container } = mountedSessionList([
    ...roots,
    ...relatedChildren(parent, "paged-child"),
  ]);
  const toggle = query(
    container,
    "button[aria-label='Expand child sessions for Root 1']",
  );
  if (!(toggle instanceof HTMLButtonElement))
    throw new TypeError("Missing toggle");
  toggle.click();

  const rootRows = "[data-session-depth='0']";
  const childRows = "[data-session-depth='1']";
  const rootCount = container.querySelectorAll(rootRows).length;
  expect(container.querySelectorAll(childRows)).toHaveLength(10);
  const loadMore = query(container, "[data-load-more-children='root-1']");
  if (!(loadMore instanceof HTMLButtonElement))
    throw new TypeError("Missing child pager");
  loadMore.click();

  expect(container.querySelectorAll(childRows)).toHaveLength(20);
  expect(container.querySelectorAll(rootRows)).toHaveLength(rootCount);
});
