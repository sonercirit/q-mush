import { expect, test } from "vitest";
import {
  clickButton,
  expectDepthCount,
  mountedSessionList,
  parentSession,
  query,
  relatedChildren,
} from "./session-list-test-helpers.tsx";

function pagedRoots(prefix: string, count: number) {
  const roots: ReturnType<typeof parentSession>[] = [];
  for (let index = 1; index <= count; index += 1) {
    roots.push({ ...parentSession(), id: `${prefix}-${String(index)}` });
  }
  return roots;
}

test("keeps the selected root visible beyond the first root page", () => {
  const roots = pagedRoots("selected-root", 11);
  const selected = roots[10];
  if (selected === undefined) throw new TypeError("Missing selected root");

  const { container } = mountedSessionList(roots, selected.id);

  expect(
    container.querySelector(`[data-session-id='${selected.id}']`),
  ).not.toBeNull();
  expectDepthCount(container, 0, 10);
});

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
  clickButton(
    container,
    "button[aria-label='Expand child sessions for Root 1']",
  );

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

test("hides the child pager after every child is visible", () => {
  const parent = parentSession();
  const children = relatedChildren(parent, "all-child").slice(0, 10);
  const { container } = mountedSessionList([parent, ...children]);
  clickButton(
    container,
    "button[aria-label='Expand child sessions for Parent task']",
  );
  expectDepthCount(container, 1, 10);
  expect(container.querySelector("[data-load-more-children]")).toBeNull();
});

test("resets child pagination when the root list identity changes", () => {
  const parent = parentSession();
  const children = relatedChildren(parent, "old-child");
  const mounted = mountedSessionList([parent, ...children]);
  clickButton(
    mounted.container,
    "button[aria-label='Expand child sessions for Parent task']",
  );
  clickButton(mounted.container, "[data-load-more-children]");
  expectDepthCount(mounted.container, 1, 20);

  const replacement = {
    ...parent,
    title: "Replacement",
  };
  const sibling = { ...parentSession(), id: "new-root" };
  mounted.controller.applyRealtime([
    replacement,
    sibling,
    ...relatedChildren(replacement, "new-child"),
  ]);
  expectDepthCount(mounted.container, 1, 10);
});

test("clamps repeated root pagination at the available roots", () => {
  const roots = pagedRoots("bounded-root", 11);
  const { container } = mountedSessionList(roots);
  const pager = query(container, "[data-load-more-sessions='true']");
  if (!(pager instanceof HTMLButtonElement))
    throw new TypeError("Missing root pager");
  pager.click();
  pager.click();
  expectDepthCount(container, 0, 11);
  expect(
    container
      .querySelector(".session-list-items")
      ?.getAttribute("data-visible-root-count"),
  ).toBe("11");
});
