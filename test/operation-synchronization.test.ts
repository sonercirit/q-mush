import { expect, test } from "vitest";
import {
  decodeOperationCheckpoint,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
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
const handler = (authenticatedId?: string) => {
  const resources = harness.setup();
  return createOperationSynchronization(resources.database, {
    authenticatedUser: () =>
      authenticatedId === undefined
        ? null
        : { id: authenticatedId, email: "owner@example.com", name: "Owner" },
  });
};

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

test("operation synchronization returns advanced frontier and checkpoint", async () => {
  const operation = testOperation("writer-a", 1n, {}, "one");
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
    "writer-a": 1n,
  });
  expect(responseBody["frontier"]).toEqual({ "writer-a": "1" });
});
