import { expect, test } from "vitest";

import { encodeOperationEnvelope } from "../shared/operation-checkpoint";
import { OPERATION_SYNCHRONIZATION_PATH } from "../shared/routes";
import { createOperationSynchronization } from "../sync-engine/operation-synchronization";
import { entityTestOperation } from "./operation-entity-test-support";
import { operationDatabase } from "./operation-producer-test-support";

const accountId = "owner-1";
const runnerId = "runner-1";
const endpoint = `http://localhost${OPERATION_SYNCHRONIZATION_PATH}`;
const operation = (writerId: string, sequence = 1n, value = "value") => {
  const created = entityTestOperation(
    writerId,
    sequence,
    sequence === 1n ? {} : { [writerId]: sequence - 1n },
    value,
    Date.now(),
  );
  return {
    ...created,
    clock: { ...created.clock, logical: Number(sequence) },
    entity: { ...created.entity, accountId },
  };
};
const requestHeaders = (headers: HeadersInit): Headers => {
  const result = new Headers(headers);
  result.set("content-type", "application/json");
  return result;
};
const request = (
  method: "POST" | "PUT",
  ownerId: string,
  envelopes: readonly string[] = [],
  headers: HeadersInit = {},
) =>
  new Request(endpoint, {
    method,
    headers: requestHeaders(headers),
    body: JSON.stringify(
      method === "POST"
        ? { ownerId, partition: "non-session", envelopes }
        : { ownerId, partition: "non-session", frontier: {} },
    ),
  });
const setup = () => {
  const resources = operationDatabase();
  const synchronized = createOperationSynchronization(resources.database, {
    runnerAccount: (incoming) =>
      incoming.headers.get("authorization") === "Bearer runner"
        ? { runnerId, userId: accountId }
        : undefined,
  });
  return { ...resources, synchronized };
};
const encoded = (writerId: string, sequence = 1n, value = "value") =>
  encodeOperationEnvelope(operation(writerId, sequence, value));

test("operation synchronization is runner-only and binds device authorship", async () => {
  const { harness, synchronized } = setup();
  const cookie = { cookie: "session=browser" };
  const bearer = { authorization: "Bearer runner" };
  const statuses = await Promise.all([
    synchronized(request("POST", "self", [], cookie)),
    synchronized(request("PUT", "self", [], cookie)),
    synchronized(request("POST", "self", [encoded(runnerId)], bearer)),
    synchronized(request("POST", "self", [encoded(accountId)], bearer)),
    synchronized(request("POST", "self", [encoded("runner-2")], bearer)),
    synchronized(request("POST", accountId, [], bearer)),
    synchronized(request("PUT", "self", [], bearer)),
  ]);
  expect(statuses.map(({ status }) => status)).toEqual([
    401, 401, 200, 403, 403, 403, 200,
  ]);
  const readBody: unknown = await statuses[6].json();
  expect(readBody).toMatchObject({
    hasMore: false,
    stableClock: null,
    stableFrontier: null,
  });
  harness.close();
});

test("operation identity equivocation is independent per device writer", async () => {
  const { database, harness, synchronized } = setup();
  const bearer = { authorization: "Bearer runner" };
  const send = (envelopes: readonly string[]) =>
    synchronized(request("POST", "self", envelopes, bearer));
  expect((await send([encoded(runnerId)])).status).toBe(200);
  const otherDevice = createOperationSynchronization(database, {
    runnerAccount: () => ({ runnerId: "runner-2", userId: accountId }),
  });
  expect(
    (
      await otherDevice(
        request("POST", "self", [encoded("runner-2", 1n, "other")]),
      )
    ).status,
  ).toBe(200);
  expect((await send([encoded(runnerId, 1n, "equivocation")])).status).toBe(
    409,
  );
  harness.close();
});
