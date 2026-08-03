import { expect, test } from "vitest";
import type { EngineHealthReason } from "../../shared/engine-health.ts";
import { storageHealthWarning } from "../storage-health.ts";

function expectReasonWarning(
  reason: EngineHealthReason,
  expected: string,
): void {
  expect(storageHealthWarning({ degraded: true, reasons: [reason] })).toContain(
    expected,
  );
}

test("describes database corruption", () => {
  expectReasonWarning("database_corrupt", "database integrity check failed");
});

test("describes a full disk", () => {
  expectReasonWarning("disk_full", "database volume is full");
});

test("describes low disk space", () => {
  expectReasonWarning("low_disk_space", "storage is running low");
});

test("hides a healthy storage snapshot", () => {
  expect(
    storageHealthWarning({ degraded: false, reasons: [] }),
  ).toBeUndefined();
});
