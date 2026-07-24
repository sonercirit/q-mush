import { describe, expect, test } from "vitest";
import { SessionController } from "../../solid/session-controller.ts";
import {
  applyCompaction,
  applyCompactionEvents,
  expectNoCompactionPreview,
  runningCompactionDetail,
  selectCompactionController,
  selectedCompactionController,
  sessionCompactionEvent,
  startedCompactionController,
} from "./session-compaction-test-helpers.ts";

describe("session compaction preview state", () => {
  test("keeps summary and reasoning separate and resets retry attempts", async () => {
    const controller = await startedCompactionController();
    const oldDelta = {
      reasoning: "Old reasoning",
      summary: "Old summary",
    };
    applyCompaction(controller, "delta", 1, oldDelta);
    applyCompaction(controller, "reset", 2, { attempt: 1 });
    applyCompaction(controller, "delta", 3, {
      attempt: 1,
      reasoning: "Fresh reasoning",
      summary: "Fresh summary",
    });

    expect(controller.state.compactionPreview).toMatchObject({
      attempt: 1,
      operationId: "operation-1",
      reasoning: "Fresh reasoning",
      summary: "Fresh summary",
    });
    expect(controller.state.detail?.messages ?? []).toEqual([]);
  });

  test("keeps an active preview through same-connection detail snapshots", async () => {
    const controller = await startedCompactionController();
    applyCompaction(controller, "delta", 1, { summary: "Still streaming" });

    controller.applyDetail(
      runningCompactionDetail(controller.state.selectedId ?? "missing"),
    );

    expect(controller.state.compactionPreview?.summary).toBe("Still streaming");
  });

  test("ignores duplicate, late, and out-of-order operations", async () => {
    const controller = await startedCompactionController();
    const selectedSummary = { summary: "second" };
    applyCompaction(controller, "delta", 2, selectedSummary);
    applyCompactionEvents(
      controller,
      sessionCompactionEvent("delta", 1, { summary: "stale" }),
      sessionCompactionEvent("start", 0, { operationId: "older-operation" }),
      sessionCompactionEvent("delta", 3, {
        operationId: "another-operation",
        summary: "wrong",
      }),
    );

    expect(controller.state.compactionPreview?.summary).toBe("second");
    applyCompactionEvents(
      controller,
      sessionCompactionEvent("failure", 3),
      sessionCompactionEvent("delta", 4, { summary: "late" }),
      sessionCompactionEvent("start", 0),
      sessionCompactionEvent("delta", 1, { summary: "reopened" }),
    );
    expectNoCompactionPreview(controller);

    applyCompaction(controller, "start", 0, {
      operationId: "new-operation",
    });
    expect(controller.state.compactionPreview?.operationId).toBe(
      "new-operation",
    );
  });

  test("bounds terminal operation history while rejecting late duplicate starts", async () => {
    const controller = await selectedCompactionController();
    for (let index = 0; index < 40; index += 1) {
      const operationId = `finished-${String(index)}`;
      applyCompactionEvents(
        controller,
        sessionCompactionEvent("start", 0, { operationId }),
        sessionCompactionEvent("complete", 1, { operationId }),
      );
    }

    applyCompaction(controller, "start", 0, { operationId: "finished-39" });
    expectNoCompactionPreview(controller);

    applyCompaction(controller, "start", 0, { operationId: "finished-0" });
    expect(controller.state.compactionPreview?.operationId).toBe("finished-0");
  });

  test("terminal events, snapshots, reset, and selection changes clear previews", async () => {
    const controller = new SessionController();
    for (const phase of ["complete", "cancel", "failure"] as const) {
      const operationId = `terminal-${phase}`;
      applyCompactionEvents(
        controller,
        sessionCompactionEvent("start", 0, { operationId }),
        sessionCompactionEvent(phase, 1, { operationId }),
      );
      expectNoCompactionPreview(controller);
    }

    applyCompaction(controller, "start", 0);
    controller.clearCompactionPreview();
    expectNoCompactionPreview(controller);

    applyCompaction(controller, "start", 0, { operationId: "reset" });
    controller.reset();
    expectNoCompactionPreview(controller);

    applyCompaction(controller, "start", 0, { operationId: "switch" });
    await selectCompactionController(
      controller,
      runningCompactionDetail("other"),
    );
    expectNoCompactionPreview(controller);
  });
});
