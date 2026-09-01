import { expect, test } from "vitest";

import { encodeOperationEnvelope } from "../shared/operation-checkpoint";
import { MAX_OPERATION_SYNC_BATCH_BYTES } from "../shared/operation-core";
import { createOperationStore } from "../sync-engine/operation-store";
import { createOperationSynchronization } from "../sync-engine/operation-synchronization";
import {
  largeEntityEnvelope,
  operationDatabase,
} from "./operation-producer-test-support";

const ownerId = "owner-1";
const encoded = (sequence: bigint, bytes: number) =>
  encodeOperationEnvelope(largeEntityEnvelope(ownerId, sequence, bytes));

test("synchronization POST rejects a batch above the byte cap", async () => {
  const { harness, database } = operationDatabase();
  const handler = createOperationSynchronization(database, {
    authenticatedUser: () => ({
      id: ownerId,
      email: "a@example.test",
      name: "A",
    }),
  });
  const envelope = encoded(1n, 240_000);
  const request = new Request("http://localhost/operations", {
    body: JSON.stringify({
      ownerId,
      partition: "non-session",
      envelopes: Array.from({ length: 18 }, () => envelope),
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const response = await handler(request);
  expect(response.status).toBe(400);
  harness.close();
});

test("synchronization rejects an oversized raw body before JSON parsing", async () => {
  const { harness, database } = operationDatabase();
  let authenticationCalls = 0;
  const handler = createOperationSynchronization(database, {
    authenticatedUser: () => {
      authenticationCalls += 1;
      return {
        id: ownerId,
        email: "a@example.test",
        name: "A",
      };
    },
  });
  const raw = `{"unterminated":"${"x".repeat(MAX_OPERATION_SYNC_BATCH_BYTES + 1024 * 1024)}`;
  const response = await handler(
    new Request("http://localhost/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
  );
  expect(response.status).toBe(400);
  expect(authenticationCalls).toBe(0);
  harness.close();
});

test("operation store byte-caps pull pages and resumes with hasMore", () => {
  const { harness, database } = operationDatabase();
  const store = createOperationStore({ database });
  const now = Date.now();
  for (let index = 1; index <= 20; index += 1) {
    const sequence = BigInt(index);
    store.appendEnvelope(
      ownerId,
      largeEntityEnvelope(ownerId, sequence, 240_000, now + index),
      ownerId,
      now,
    );
  }
  const page = store.readEncodedEnvelopes(ownerId, "non-session", {}, 256);
  expect(page.envelopes.length).toBeGreaterThan(1);
  expect(page.envelopes.join("").length).toBeLessThanOrEqual(
    MAX_OPERATION_SYNC_BATCH_BYTES,
  );
  expect(page.hasMore).toBe(true);
  const last = BigInt(page.envelopes.length);
  expect(
    store.readEncodedEnvelopes(ownerId, "non-session", { [ownerId]: last }, 256)
      .envelopes,
  ).toHaveLength(20 - page.envelopes.length);
  harness.close();
});
