import { expect, test } from "vitest";
import {
  decodeOperationCheckpoint,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import { MAX_OPERATION_BATCH_SIZE } from "../shared/operation-core";
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
const body = (ownerId = "owner-1", envelopes: readonly string[] = []) => ({
  ownerId,
  partition: "non-session",
  envelopes,
});
const ownedOperation = (sequence = 1n) => ({
  ...testOperation("owner-1", sequence, {}, "one"),
  entity: {
    ...testOperation("owner-1", sequence, {}, "one").entity,
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
const operationStatus = (operation: ReturnType<typeof ownedOperation>) =>
  synchronizationStatus([encodeOperationEnvelope(operation)]);
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

test("operation synchronization accepts its maximum batch size", async () => {
  expect(await repeatedOperationStatus(MAX_OPERATION_BATCH_SIZE)).toBe(200);
});

test("operation synchronization rejects a well-formed batch above its maximum", async () => {
  expect(await repeatedOperationStatus(MAX_OPERATION_BATCH_SIZE + 1)).toBe(400);
});

test("operation synchronization returns advanced frontier and checkpoint", async () => {
  const operation = ownedOperation();
  const response = await handler("owner-1")(
    request(body("owner-1", [encodeOperationEnvelope(operation)])),
  );
  expect(response.status).toBe(200);
  const responseBody: unknown = await response.json();
  expect(isRecord(responseBody)).toBe(true);
  if (!isRecord(responseBody)) throw new Error("Expected response record");
  const checkpoint = responseBody["checkpoint"];
  expect(typeof checkpoint).toBe("string");
  if (typeof checkpoint !== "string") throw new Error("Expected checkpoint");
  expect(decodeOperationCheckpoint(checkpoint).frontier).toEqual({
    "owner-1": 1n,
  });
  expect(responseBody["frontier"]).toEqual({ "owner-1": "1" });
});
