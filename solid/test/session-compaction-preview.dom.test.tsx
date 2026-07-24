import { afterEach, expect, test } from "vitest";
import type { SessionController } from "../session-controller.ts";
import { sessionCompactionEvent } from "./session-compaction-test-helpers.ts";
import {
  disposeTestViews,
  DOM_TEST_DISPOSALS,
  mountTestSessionDetail,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

afterEach(() => {
  disposeTestViews();
});

function mount(): {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
} {
  return mountTestSessionDetail(
    { ...TEST_SESSION_DETAIL, status: "running" },
    DOM_TEST_DISPOSALS,
  );
}

test("updates one temporary preview in place and removes it at completion", () => {
  const { container, controller } = mount();
  controller.applyCompaction(sessionCompactionEvent("start", 0));
  const preview = container.querySelector("[data-compaction-preview]");
  expect(preview).not.toBeNull();
  expect(container.textContent).toContain("Compacting conversation");

  controller.applyCompaction(
    sessionCompactionEvent("delta", 1, {
      reasoning: "Reasoning",
      summary: "Summary",
    }),
  );
  expect(container.querySelector("[data-compaction-preview]")).toBe(preview);
  expect(container.textContent).toContain("Summary");
  expect(container.textContent).toContain("Reasoning");
  expect(container.querySelectorAll("[data-compaction-preview]")).toHaveLength(
    1,
  );

  controller.applyCompaction(sessionCompactionEvent("complete", 2));
  expect(container.querySelector("[data-compaction-preview]")).toBeNull();
  expect(TEST_SESSION_DETAIL.messages).toEqual([]);
});
