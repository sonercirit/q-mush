import { expect, test } from "vitest";
import {
  cappedSessionCreationBaseline,
  cappedSessionCreationIds,
  MAXIMUM_CREATION_RECONCILIATION_IDENTITIES,
} from "../../solid/session-pending.ts";

test("bounds creation reconciliation identity snapshots deterministically", () => {
  const sessions = Array.from(
    { length: MAXIMUM_CREATION_RECONCILIATION_IDENTITIES + 3 },
    (_, index) => ({ id: `session-${String(index)}`, updatedAt: index }),
  );

  const baseline = cappedSessionCreationBaseline(sessions);
  expect(baseline.ids).toEqual(
    new Set(
      [...sessions]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAXIMUM_CREATION_RECONCILIATION_IDENTITIES)
        .map(({ id }) => id),
    ),
  );
  expect(baseline.bounded).toBe(false);
});

test("caps a legacy identity set before retaining it", () => {
  const ids = new Set(
    Array.from(
      { length: MAXIMUM_CREATION_RECONCILIATION_IDENTITIES + 1 },
      (_, index) => `session-${String(index)}`,
    ),
  );

  const baseline = cappedSessionCreationIds(ids);
  expect(baseline.bounded).toBe(false);
  expect(baseline.ids.size).toBe(MAXIMUM_CREATION_RECONCILIATION_IDENTITIES);
});

test("marks a creation baseline bounded only when every identity fits", () => {
  const baseline = cappedSessionCreationBaseline([
    { id: "session-1", updatedAt: 2 },
    { id: "session-2", updatedAt: 1 },
  ]);
  expect(baseline).toEqual({
    bounded: true,
    ids: new Set(["session-1", "session-2"]),
  });
});
