import { Database } from "bun:sqlite";
import { expect, test } from "vitest";

import { createRunnerOperationStore } from "../runner/runner-operation-store.ts";
import { encodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import { testOperation } from "./operation-core-test-support.ts";

const envelope = (sequence: bigint, value = `value-${String(sequence)}`) => {
  const operation = testOperation(
    "owner-1",
    sequence,
    {},
    value,
    Number(sequence),
  );
  return encodeOperationEnvelope({
    ...operation,
    entity: { ...operation.entity, accountId: "owner-1" },
  });
};
type Store = ReturnType<typeof createRunnerOperationStore>;
const withStore = (run: (store: Store) => void) => {
  const database = new Database(":memory:");
  try {
    run(createRunnerOperationStore(database));
  } finally {
    database.close();
  }
};
const remote = (store: Store, envelopes: readonly string[]) => {
  store.apply("owner-1", "non-session", envelopes, "remote");
};
const rows = (store: Store) => store.inspect("owner-1", "non-session");
const expectFrontierOne = (store: Store) => {
  expect(store.state("owner-1", "non-session").frontier).toEqual({
    "owner-1": 1n,
  });
};

test("durably commits a verified immutable envelope and checkpoint", () => {
  withStore((store) => {
    const encoded = envelope(1n);
    remote(store, [encoded]);
    const recorded = rows(store);
    expect(recorded[0]).toMatchObject({
      encoded,
      source: "remote",
      verificationState: "verified",
    });
    expect(recorded[0]?.rejectionReason).toBeNull();
    expectFrontierOne(store);
  });
});

test("treats duplicate envelopes as idempotent", () => {
  withStore((store) => {
    const duplicate = envelope(1n);
    remote(store, Array(3).fill(duplicate));
    expect(
      rows(store).map(({ verificationState }) => verificationState),
    ).toEqual(["verified"]);
    expect(store.state("owner-1", "non-session").projection.join(",")).toBe(
      "owner-1-1",
    );
  });
});

test("quarantines malformed envelopes while applying valid peers", () => {
  withStore((store) => {
    remote(store, ["not-json", envelope(1n)]);
    const recorded = rows(store);
    expect(recorded.map(({ verificationState }) => verificationState)).toEqual([
      "rejected",
      "verified",
    ]);
    expect(recorded[0]?.rejectionReason).toBeTruthy();
    expectFrontierOne(store);
  });
});

test("rolls back the whole valid batch after a mid-batch conflict", () => {
  withStore((store) => {
    const first = envelope(1n);
    remote(store, [first]);
    expect(() => {
      remote(store, [envelope(2n), envelope(1n, "equivocation")]);
    }).toThrow("equivocation");
    expect(rows(store).map(({ encoded }) => encoded)).toEqual([first]);
    expectFrontierOne(store);
  });
});

test("keeps local envelopes pending until durable acknowledgement", () => {
  withStore((store) => {
    const local = envelope(1n, "outbox");
    store.apply("owner-1", "non-session", [local], "local");
    const before = store.pending("owner-1", "non-session");
    expect(before).toContain(local);
    store.acknowledge("owner-1", "non-session", before);
    expect(store.pending("owner-1", "non-session").length).toBe(0);
  });
});
