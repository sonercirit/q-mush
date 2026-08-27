import { expect, test } from "vitest";
import { encodeOperationEnvelope } from "../shared/operation-checkpoint";
import {
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_ENVELOPE_BYTES,
  MAX_REMOTE_CLOCK_DRIFT_MS,
} from "../shared/operation-core";
import { isRecord } from "../shared/validation";
import { createOperationSynchronization } from "../sync-engine/operation-synchronization";
import { testOperation } from "./operation-core-test-support";
import { createOperationDatabaseHarness } from "./operation-store-test-support";

const harness = createOperationDatabaseHarness();
const request = (body: unknown) =>
  new Request("http://localhost/api/local/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const body = (
  ownerId = "owner-1",
  envelopes: readonly string[] = [],
  partition: "non-session" | "session" = "non-session",
) => ({
  ownerId,
  partition,
  envelopes,
});
const ownedOperation = (sequence = 1n) => ({
  ...testOperation("owner-1", sequence, {}, "one", Date.now()),
  entity: {
    ...testOperation("owner-1", sequence, {}, "one", Date.now()).entity,
    accountId: "owner-1",
  },
});
const handler = (authenticatedId?: string) => {
  const resources = harness.setup();
  return createOperationSynchronization(resources.database, {
    authenticatedUser: () =>
      authenticatedId === undefined
        ? null
        : { id: authenticatedId, email: "owner@example.com", name: "Owner" },
  });
};
const synchronizationStatus = async (envelopes: readonly string[]) =>
  (await handler("owner-1")(request(body("owner-1", envelopes)))).status;
const expectSynchronizationStatus = async (
  envelope: string,
  expected: number,
) => {
  expect(await synchronizationStatus([envelope])).toBe(expected);
};
const operationResponse = (
  operation: ReturnType<typeof ownedOperation>,
  partition: "non-session" | "session" = "non-session",
) =>
  handler("owner-1")(
    request(body("owner-1", [encodeOperationEnvelope(operation)], partition)),
  );
const operationStatus = async (operation: ReturnType<typeof ownedOperation>) =>
  (await operationResponse(operation)).status;
const repeatedOperationStatus = (length: number) =>
  synchronizationStatus(
    Array(length).fill(encodeOperationEnvelope(ownedOperation())),
  );

test.afterEach(harness.close);

test("operation synchronization rejects unauthenticated requests", async () => {
  expect((await handler()(request(body()))).status).toBe(401);
});

test("operation synchronization rejects cross-owner requests", async () => {
  expect((await handler("owner-1")(request(body("owner-2")))).status).toBe(403);
});

test("operation synchronization rejects malformed payloads", async () => {
  expect(
    (await handler("owner-1")(request({ ownerId: "owner-1" }))).status,
  ).toBe(400);
});

test("operation synchronization bounds operation batches", async () => {
  expect(
    (await handler("owner-1")(request(body("owner-1", Array(513).fill("x")))))
      .status,
  ).toBe(400);
});

test("operation synchronization rejects an operation for another account", async () => {
  const operation = ownedOperation();
  const crossAccount = {
    ...operation,
    entity: { ...operation.entity, accountId: "owner-2" },
  };
  expect(await operationStatus(crossAccount)).toBe(403);
});

test("operation synchronization rejects another writer identity", async () => {
  const operation = { ...ownedOperation(), writerId: "owner-2" };
  expect(await operationStatus(operation)).toBe(403);
});

test("operation synchronization rejects remote clock drift in either direction", async () => {
  const now = Date.now();
  for (const physicalMs of [
    now + MAX_REMOTE_CLOCK_DRIFT_MS * 2,
    Math.max(0, now - MAX_REMOTE_CLOCK_DRIFT_MS * 2),
  ])
    expect(
      await operationStatus({
        ...ownedOperation(),
        clock: { ...ownedOperation().clock, physicalMs },
      }),
    ).toBe(400);
});

test("operation synchronization rejects oversized envelopes", async () => {
  const oversized = "x".repeat(MAX_OPERATION_ENVELOPE_BYTES + 1);
  await expectSynchronizationStatus(oversized, 400);
});

test("operation synchronization measures envelope limits in UTF-8 bytes", async () => {
  const oversized = "🦆".repeat(MAX_OPERATION_ENVELOPE_BYTES / 2);
  await expectSynchronizationStatus(oversized, 400);
});

test("operation synchronization reports malformed oversized envelopes clearly", async () => {
  const response = await handler("owner-1")(
    request(body("owner-1", ["x".repeat(MAX_OPERATION_ENVELOPE_BYTES + 1)])),
  );
  expect(await response.json()).toEqual({ error: "Invalid request" });
});

test("operation synchronization accepts its maximum batch size", async () => {
  expect(await repeatedOperationStatus(MAX_OPERATION_BATCH_SIZE)).toBe(200);
});

test("operation synchronization rejects a well-formed batch above its maximum", async () => {
  expect(await repeatedOperationStatus(MAX_OPERATION_BATCH_SIZE + 1)).toBe(400);
});

test("operation synchronization returns only the advanced frontier", async () => {
  const operation = ownedOperation();
  const response = await operationResponse(operation);
  expect(response.status).toBe(200);
  const responseBody: unknown = await response.json();
  expect(isRecord(responseBody)).toBe(true);
  if (!isRecord(responseBody)) throw new Error("Expected response record");
  expect(responseBody).toEqual({ frontier: { "owner-1": "1" } });
});

test("operation synchronization maps malformed envelopes to bad request", async () => {
  expect(await synchronizationStatus(["not-an-envelope"])).toBe(400);
});

test("operation synchronization maps partition scope mismatch to bad request", async () => {
  const operation = ownedOperation(1n);
  const response = await operationResponse(operation, "session");
  const mismatchBody: unknown = await response.json();
  expect({ status: response.status, body: mismatchBody }).toEqual({
    status: 400,
    body: { error: "Operation intake scope mismatch" },
  });
});

test("operation synchronization maps identity equivocation to conflict", async () => {
  const operation = ownedOperation();
  const first = encodeOperationEnvelope(operation);
  const changed = encodeOperationEnvelope({
    ...operation,
    payload: { value: "changed" },
  });
  expect(await synchronizationStatus([first, changed])).toBe(409);
});

test("operation synchronization maps storage faults to server errors", async () => {
  const synchronized = handler("owner-1");
  harness.close();
  const originalError = console.error;
  console.error = () => undefined;
  try {
    expect(await synchronized(request(body()))).toHaveProperty("status", 500);
  } finally {
    console.error = originalError;
  }
});

test("operation synchronization response stays bounded as history grows", async () => {
  const synchronized = handler("owner-1");
  let responseLength = 0;
  for (let sequence = 1; sequence <= 40; sequence += 1) {
    const operation = ownedOperation(BigInt(sequence));
    const response = await synchronized(
      request(body("owner-1", [encodeOperationEnvelope(operation)])),
    );
    responseLength = (await response.text()).length;
  }
  expect(responseLength).toBeLessThan(100);
});

test("operation synchronization rejects unknown request fields", async () => {
  expect(
    (await handler("owner-1")(request({ ...body(), unexpected: true }))).status,
  ).toBe(400);
});

test("operation synchronization returns deterministic bounded missing pages", async () => {
  const synchronized = handler("owner-1");
  const operations = [ownedOperation(2n), ownedOperation(1n)];
  expect(
    (
      await synchronized(
        request(body("owner-1", operations.map(encodeOperationEnvelope))),
      )
    ).status,
  ).toBe(200);
  const read = new Request("http://localhost/api/local/operations", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ownerId: "owner-1",
      partition: "non-session",
      frontier: {},
    }),
  });
  const response = await synchronized(read);
  expect(response.status).toBe(200);
  const result: unknown = await response.json();
  expect(result).toEqual({
    envelopes: operations.slice().reverse().map(encodeOperationEnvelope),
    hasMore: false,
  });
});

test("operation synchronization acknowledges duplicate replay at history capacity", async () => {
  const synchronized = handler("owner-1");
  const envelopes = Array.from({ length: 2000 }, (_, index) =>
    encodeOperationEnvelope(ownedOperation(BigInt(index + 1))),
  );
  for (
    let offset = 0;
    offset < envelopes.length;
    offset += MAX_OPERATION_BATCH_SIZE
  )
    expect(
      (
        await synchronized(
          request(
            body(
              "owner-1",
              envelopes.slice(offset, offset + MAX_OPERATION_BATCH_SIZE),
            ),
          ),
        )
      ).status,
    ).toBe(200);
  const replay = await synchronized(
    request(body("owner-1", [envelopes[0] ?? ""])),
  );
  expect(replay.status).toBe(200);
  const overflowEnvelope = encodeOperationEnvelope(ownedOperation(2001n));
  const overflow = await synchronized(
    request(body("owner-1", [overflowEnvelope])),
  );
  expect(overflow.status).toBe(507);
});

test("remote drift limit remains five minutes", () => {
  expect(MAX_REMOTE_CLOCK_DRIFT_MS).toBe(300_000);
});
