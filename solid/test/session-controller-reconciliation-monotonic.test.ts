import { expect, test } from "vitest";
import {
  acknowledgeSessionDetail,
  newestSessionSummaries,
  reconcileSessionDetail,
  reconcileSessionSummaries,
  sessionDetailIsAtLeast,
} from "../../solid/session-controller-reconciliation.ts";
import { summaryFromDetail } from "../../solid/session-summary-codec.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function detail(
  id: string,
  generation: number,
  updatedAt: number,
  title: string,
) {
  return { ...TEST_SESSION_DETAIL, generation, id, title, updatedAt };
}

function uncertainAcknowledgement(
  baseline: ReturnType<typeof detail>,
  acknowledgement: ReturnType<typeof detail>,
) {
  return acknowledgeSessionDetail(undefined, acknowledgement, {
    baseline,
    matches: () => true,
  });
}

function expectUncertain(
  baseline: ReturnType<typeof detail>,
  acknowledgement: ReturnType<typeof detail>,
): void {
  expect(uncertainAcknowledgement(baseline, acknowledgement)).toEqual({
    status: "uncertain",
  });
}

test("rejects stale acknowledgements without regressing a newer detail", () => {
  const current = detail("session-1", 3, 30, "new snapshot");
  const acknowledgement = detail("session-1", 2, 20, "stale ack");

  expect(sessionDetailIsAtLeast(current, acknowledgement)).toBe(true);
  expect(reconcileSessionDetail(current, acknowledgement)).toBe(current);
  expect(
    acknowledgeSessionDetail(current, acknowledgement, {
      baseline: detail("session-1", 1, 10, "baseline"),
      matches: () => true,
    }),
  ).toEqual({ detail: current, status: "committed" });
});

test.each([
  ["same identity", "session-1", 2, 40, "wrong generation"],
  ["another identity", "session-2", 4, 40, "wrong identity"],
] as const)(
  "classifies an acknowledgement from $0 as uncertain",
  (_label, id, generation, updatedAt, title) => {
    const baseline = detail("session-1", 3, 30, "baseline");
    expectUncertain(baseline, detail(id, generation, updatedAt, title));
  },
);

test("uses updatedAt only within the same identity and generation", () => {
  const current = detail("session-1", 2, 30, "new snapshot");
  const newer = detail("session-1", 2, 40, "new ack");
  const other = detail("session-2", 99, 99, "other identity");

  expect(reconcileSessionDetail(current, newer)).toBe(newer);
  expect(reconcileSessionDetail(current, other)).toBe(current);
});

test("deduplicates summary generations without allowing a later stale copy", () => {
  const newest = summaryFromDetail(detail("session-1", 3, 30, "newest"));
  const stale = summaryFromDetail(detail("session-1", 2, 40, "stale"));

  expect(newestSessionSummaries([newest, stale])).toEqual([newest]);
});

test("merges summary acknowledgements monotonically by identity", () => {
  const selectedNew = summaryFromDetail(
    detail("session-1", 3, 30, "selected new"),
  );
  const selectedOld = summaryFromDetail(
    detail("session-1", 2, 20, "selected old"),
  );
  const neighbor = summaryFromDetail(detail("session-2", 1, 50, "neighbor"));

  expect(
    reconcileSessionSummaries([selectedNew, neighbor], [selectedOld]),
  ).toEqual([selectedNew, neighbor]);
});
