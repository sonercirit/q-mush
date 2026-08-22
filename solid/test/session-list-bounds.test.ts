import { expect, test } from "vitest";
import { boundedSessionRows } from "../session-list-bounds.ts";

function row(id: string, depth: number) {
  return { depth, session: { id } };
}

test("returns the original ordered rows when they already fit", () => {
  const rows = [row("second", 0), row("first", 0)];
  expect(boundedSessionRows(rows, 2, "first")).toBe(rows);
});

test("keeps only the deepest selected ancestry when its path exceeds the limit", () => {
  const rows = [
    row("leading", 0),
    row("ancestor-0", 0),
    row("ancestor-1", 1),
    row("ancestor-2", 2),
    row("selected", 3),
  ];
  expect(boundedSessionRows(rows, 2, "selected")).toEqual([rows[3], rows[4]]);
});
