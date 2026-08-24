import { expect, test } from "vitest";
import {
  createPendingCommandCapacity,
  type PendingCommandCapacity,
  pendingCommandPayloadBytes,
  withPendingCommandCapacity,
} from "../../solid/session-pending.ts";

function payload(bytes: number) {
  return { value: "x".repeat(bytes) };
}

function pendingBytes(bytes: number): number {
  return pendingCommandPayloadBytes(payload(bytes));
}

function expectReserve(
  capacity: PendingCommandCapacity,
  userId: string,
  bytes: number,
  defined: boolean,
) {
  const reservation = capacity.reserve(userId, bytes);
  if (defined) expect(reservation).toBeDefined();
  else expect(reservation).toBeUndefined();
  return reservation;
}

test("enforces the aggregate pending-command byte cap across users", () => {
  const capacity = createPendingCommandCapacity(25);
  const first = pendingBytes(8);
  const second = pendingBytes(7);
  const reserve = (userId: string, bytes: number, defined: boolean) =>
    expectReserve(capacity, userId, bytes, defined);

  reserve("user-1", first, true);
  reserve("user-2", second, false);
  expect(capacity.bytes).toBe(first);
});

test.each(["settle", "reject", "throw", "replay"] as const)(
  "reclaims exact aggregate capacity on %s",
  (path) => {
    const first = pendingBytes(8);
    const second = pendingBytes(7);

    const capacity = createPendingCommandCapacity(first + second - 1);

    const firstReservation = expectReserve(capacity, "user-1", first, true);
    expectReserve(capacity, "user-2", second, false);
    firstReservation?.release(path);
    expect(capacity.bytes).toBe(0);
    expectReserve(capacity, "user-2", second, true);
    expect(capacity.bytes).toBe(second);
  },
);

test("does not double-release replayed payload capacity", () => {
  const bytes = pendingCommandPayloadBytes(payload(8));
  const capacity = createPendingCommandCapacity(bytes);

  const reservation = capacity.reserve("user-1", bytes);
  expect(reservation).toBeDefined();
  reservation?.release("settle");
  reservation?.release("replay");
  expect(capacity.bytes).toBe(0);
});

test("reclaims a global reservation after synchronous throw", async () => {
  await expect(
    withPendingCommandCapacity("user-1", payload(8), () => {
      throw new Error("sync failure");
    }),
  ).rejects.toThrow("sync failure");
  await expect(
    withPendingCommandCapacity("user-2", payload(8), () =>
      Promise.resolve("reclaimed"),
    ),
  ).resolves.toBe("reclaimed");
});
