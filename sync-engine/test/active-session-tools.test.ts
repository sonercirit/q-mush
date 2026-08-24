import { describe, expect, test } from "vitest";
import { createActiveSessionTools } from "../active-session-tools.ts";

describe("active session tools", () => {
  test("can omit runner-backed invocations already counted by the broker", () => {
    const active = createActiveSessionTools();
    active.begin("session-1", "parallel:0", "read", {
      runnerCommand: true,
    });
    active.begin("session-1", "parallel:1", "brave_search");

    expect(active.progress("session-1", false)).toEqual([
      { count: 1, name: "brave_search" },
    ]);
    const fullProgress = active.progress("session-1");
    expect(fullProgress).toHaveLength(2);
    expect(fullProgress).toContainEqual({ count: 1, name: "read" });
    expect(fullProgress).toContainEqual({ count: 1, name: "brave_search" });
  });

  test("counts distinct same-name and nested invocations", () => {
    const active = createActiveSessionTools();
    const finishFirst = active.begin("session-1", "parallel", "read");
    const finishSecond = active.begin("session-1", "parallel", "read");
    const finishSearch = active.begin("session-1", "parallel", "brave_search");

    expect(active.progress("session-1")).toEqual([
      { count: 2, name: "read" },
      { count: 1, name: "brave_search" },
    ]);
    finishFirst();
    finishFirst();
    const remaining = active.progress("session-1");
    expect(remaining).toHaveLength(2);
    expect(remaining).toContainEqual({ count: 1, name: "read" });
    expect(remaining).toContainEqual({ count: 1, name: "brave_search" });
    finishSecond();
    finishSearch();
    expect(active.progress("session-1")).toEqual([]);
  });
});
