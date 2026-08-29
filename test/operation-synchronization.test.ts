import { expect, test } from "vitest";
import {
  decodeOperationEnvelope,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import {
  MAX_OPERATION_BATCH_SIZE,
  MAX_OPERATION_CHECKPOINT_BYTES,
  MAX_OPERATION_ENVELOPE_BYTES,
  MAX_OWNER_PARTITION_OPERATIONS,
  MAX_REMOTE_CLOCK_DRIFT_MS,
} from "../shared/operation-core";
import { OPERATION_SYNCHRONIZATION_PATH } from "../shared/routes";
import { isRecord } from "../shared/validation";
import { type OperationIntakeLimits } from "../sync-engine/operation-intake";
import { createOperationStore } from "../sync-engine/operation-store";
import { createOperationSynchronization } from "../sync-engine/operation-synchronization";
import { testOperation } from "./operation-core-test-support";
import { createOperationDatabaseHarness } from "./operation-store-test-support";

const harness = createOperationDatabaseHarness();
const jsonRequest = (method: "POST" | "PUT", payload: unknown) =>
  new Request(`http://localhost${OPERATION_SYNCHRONIZATION_PATH}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
const request = (body: unknown) => jsonRequest("POST", body);
const readRequest = (
  frontier: unknown,
  extra: Readonly<Record<string, unknown>> = {},
) =>
  jsonRequest("PUT", {
    ownerId: "owner-1",
    partition: "non-session",
    frontier,
    ...extra,
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
const ownedOperation = (sequence = 1n) => {
  const operation = testOperation("owner-1", sequence, {}, "one", Date.now());
  return {
    ...operation,
    clock: { ...operation.clock, logical: Number(sequence) },
    entity: {
      ...operation.entity,
      accountId: "owner-1",
    },
  };
};
const handler = (authenticatedId?: string, limits?: OperationIntakeLimits) => {
  const resources = harness.setup();
  return createOperationSynchronization(
    resources.database,
    {
      authenticatedUser: () =>
        authenticatedId === undefined
          ? null
          : { id: authenticatedId, email: "owner@example.com", name: "Owner" },
    },
    limits,
  );
};
const statusAfterClosedDatabase = async (request: Request) => {
  const synchronized = handler("owner-1");
  harness.close();
  const originalError = console.error;
  console.error = () => undefined;
  try {
    return (await synchronized(request)).status;
  } finally {
    console.error = originalError;
  }
};
const synchronizationStatus = async (envelopes: readonly string[]) =>
  (await handler("owner-1")(request(body("owner-1", envelopes)))).status;
const expectSynchronizationStatus = async (
  envelope: string,
  expected: number,
) => {
  expect(await synchronizationStatus([envelope])).toBe(expected);
};
const oversizedFrontierStatus = async (
  frontier: Readonly<Record<string, string>>,
) => (await handler("owner-1")(readRequest(frontier))).status;
const decodedWriterIds = (value: unknown): readonly string[] => {
  if (!isRecord(value)) throw new Error("Expected response record");
  const envelopes = value["envelopes"];
  if (!Array.isArray(envelopes)) throw new Error("Expected envelope array");
  return envelopes
    .filter((envelope): envelope is string => typeof envelope === "string")
    .map(decodeOperationEnvelope)
    .map(({ writerId }) => writerId);
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
const ownedEnvelopes = (length: number) =>
  Array<undefined>(length)
    .fill(undefined)
    .map((_, index) =>
      encodeOperationEnvelope(ownedOperation(BigInt(index + 1))),
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

test("operation synchronization pins protocol request limits", () => {
  expect({
    batchSize: MAX_OPERATION_BATCH_SIZE,
    checkpointBytes: MAX_OPERATION_CHECKPOINT_BYTES,
    envelopeBytes: MAX_OPERATION_ENVELOPE_BYTES,
    ownerPartitionOperations: MAX_OWNER_PARTITION_OPERATIONS,
    remoteClockDriftMs: MAX_REMOTE_CLOCK_DRIFT_MS,
  }).toEqual({
    batchSize: 512,
    checkpointBytes: 4_194_304,
    envelopeBytes: 16_384,
    ownerPartitionOperations: 2_000,
    remoteClockDriftMs: 300_000,
  });
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
  const operation = ownedOperation();
  const otherWriter = {
    ...operation,
    writerId: "owner-2",
    clock: { ...operation.clock, writerId: "owner-2" },
  };
  expect(await operationStatus(otherWriter)).toBe(403);
});

test("operation synchronization safely accepts own prototype-named parents", async () => {
  const operation = ownedOperation();
  const parents: Record<string, bigint> = {};
  Object.defineProperty(parents, "__proto__", {
    enumerable: true,
    value: 0n,
  });
  const response = await operationResponse({ ...operation, parents });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('"frontier":{"owner-1":"1"}');
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

test("operation envelope round trip preserves an own prototype-named payload key", () => {
  const payload: Record<string, unknown> = { b: 1 };
  Object.defineProperty(payload, "__proto__", {
    enumerable: true,
    value: "x",
  });
  const operation = { ...ownedOperation(), payload };
  const decoded = decodeOperationEnvelope(encodeOperationEnvelope(operation));
  expect(isRecord(decoded.payload)).toBe(true);
  if (!isRecord(decoded.payload)) throw new Error("Expected payload record");
  expect(Object.keys(decoded.payload)).toEqual(["b", "__proto__"]);
  expect(Object.hasOwn(decoded.payload, "__proto__")).toBe(true);
  expect(decoded.payload).toEqual(payload);
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
  expect(await statusAfterClosedDatabase(request(body()))).toBe(500);
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
  const writeStatus = (
    await handler("owner-1")(request({ ...body(), unexpected: true }))
  ).status;
  expect(writeStatus).toBe(400);
});

test("operation synchronization rejects unknown read request fields", async () => {
  const readStatus = (
    await handler("owner-1")(readRequest({}, { unexpected: true }))
  ).status;
  expect(readStatus).toBe(400);
});

test("operation synchronization bounds frontier writers and components", async () => {
  const synchronized = handler("owner-1");
  const maximum = Object.fromEntries(
    Array.from({ length: 512 }, (_, index) => [
      `writer-${index.toString()}`,
      "0",
    ]),
  );
  expect((await synchronized(readRequest(maximum))).status).toBe(200);
  expect(
    (await synchronized(readRequest({ ...maximum, overflow: "0" }))).status,
  ).toBe(400);
  expect(
    await oversizedFrontierStatus({ ["x".repeat(16 * 1024 + 1)]: "0" }),
  ).toBe(400);
  expect(
    await oversizedFrontierStatus({ writer: "1".repeat(16 * 1024 + 1) }),
  ).toBe(400);
});

test("operation synchronization rejects invalid read scope and frontier syntax", async () => {
  const synchronized = handler("owner-1");
  expect((await synchronized(readRequest({ "": "0" }))).status).toBe(400);
  expect((await synchronized(readRequest({ writer: "1e5" }))).status).toBe(400);
  expect(
    (
      await synchronized(
        jsonRequest("PUT", {
          ownerId: "owner-1",
          partition: "other",
          frontier: {},
        }),
      )
    ).status,
  ).toBe(400);
});

test.each(["", "00", "01", "007", "-5"])(
  "operation synchronization rejects noncanonical frontier sequence %j",
  async (sequence) => {
    expect(await oversizedFrontierStatus({ writer: sequence })).toBe(400);
  },
);

test("operation synchronization accepts inclusive frontier component limits", async () => {
  expect(await oversizedFrontierStatus({ ["x".repeat(16_384)]: "0" })).toBe(
    200,
  );
  expect(await oversizedFrontierStatus({ writer: "1".repeat(16_384) })).toBe(
    200,
  );
});

test("operation synchronization rejects prototype frontier keys", async () => {
  const read = new Request(
    `http://localhost${OPERATION_SYNCHRONIZATION_PATH}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"ownerId":"owner-1","partition":"non-session","frontier":{"__proto__":"0"}}',
    },
  );
  expect((await handler("owner-1")(read)).status).toBe(400);
});

test("operation synchronization catches read storage faults", async () => {
  expect(await statusAfterClosedDatabase(readRequest({}))).toBe(500);
});

test("operation synchronization delivers a writer absent from the request frontier", async () => {
  const synchronized = handler("owner-1");
  const store = createOperationStore({ database: harness.current() });
  store.appendEnvelope("owner-1", ownedOperation(), "owner-1", 1);
  store.appendEnvelope(
    "owner-1",
    {
      ...ownedOperation(),
      writerId: "writer-b",
      operationId: "writer-b-1",
      clock: { ...ownedOperation().clock, writerId: "writer-b" },
    },
    "owner-1",
    1,
  );
  const response = await synchronized(readRequest({ "owner-1": "1" }));
  expect(decodedWriterIds(await response.json())).toEqual(["writer-b"]);
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
  const read = readRequest({});
  const response = await synchronized(read);
  expect(response.status).toBe(200);
  const result: unknown = await response.json();
  expect(result).toEqual({
    envelopes: operations.slice().reverse().map(encodeOperationEnvelope),
    hasMore: false,
  });
});

test("operation synchronization limits missing-envelope pages to 256", async () => {
  const synchronized = handler("owner-1");
  const envelopes = ownedEnvelopes(257);
  expect((await synchronized(request(body("owner-1", envelopes)))).status).toBe(
    200,
  );
  const response = await synchronized(readRequest({}));
  const result: unknown = await response.json();
  expect(isRecord(result) && Array.isArray(result["envelopes"])).toBe(true);
  if (!isRecord(result) || !Array.isArray(result["envelopes"]))
    throw new Error("Expected envelope page");
  expect({
    length: result["envelopes"].length,
    hasMore: result["hasMore"],
  }).toEqual({ length: 256, hasMore: true });
});

test("operation synchronization advertises both supported methods", async () => {
  const response = await handler("owner-1")(
    new Request(`http://localhost${OPERATION_SYNCHRONIZATION_PATH}`, {
      method: "GET",
    }),
  );
  expect({
    status: response.status,
    allow: response.headers.get("allow"),
  }).toEqual({ status: 405, allow: "POST, PUT" });
});

test("operation synchronization fails closed at capacity without counting duplicates", async () => {
  const synchronized = handler("owner-1", {
    ownerPartitionOperations: 2,
  });
  const envelopes = ownedEnvelopes(3);
  const initial = await synchronized(
    request(body("owner-1", envelopes.slice(0, 2))),
  );
  const replay = await synchronized(
    request(body("owner-1", [envelopes[0] ?? ""])),
  );
  const overflow = await synchronized(
    request(body("owner-1", [envelopes[2] ?? ""])),
  );
  expect({
    initial: initial.status,
    replay: replay.status,
    overflow: overflow.status,
  }).toEqual({ initial: 200, replay: 200, overflow: 507 });
});

test("operation synchronization fails closed above checkpoint byte capacity", async () => {
  const response = await handler("owner-1", { checkpointBytes: 1 })(
    request(body("owner-1", [encodeOperationEnvelope(ownedOperation())])),
  );
  expect(response.status).toBe(507);
});

test("remote drift accepts operations at the five-minute boundary", async () => {
  const now = Date.now();
  const operation = ownedOperation();
  expect(
    await operationStatus({
      ...operation,
      clock: {
        ...operation.clock,
        physicalMs: now + MAX_REMOTE_CLOCK_DRIFT_MS - 100,
      },
    }),
  ).toBe(200);
});
