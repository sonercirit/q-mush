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
const withStore = (run: (store: Store, database: Database) => void) => {
  const database = new Database(":memory:");
  try {
    run(createRunnerOperationStore(database), database);
  } finally {
    database.close();
  }
};
const remote = (store: Store, envelopes: readonly string[]) => {
  store.apply("owner-1", "non-session", envelopes, "remote");
};
const rows = (store: Store) => store.inspect("owner-1", "non-session");
const verificationStates = (store: Store) =>
  rows(store).map(({ verificationState }) => verificationState);
const expectStates = (store: Store, expected: readonly string[]) => {
  expect(verificationStates(store)).toEqual(expected);
};
const expectFrontierOne = (store: Store) => {
  expect(store.state("owner-1", "non-session").frontier).toEqual({
    "owner-1": 1n,
  });
};

test("records accepted immutable envelopes and checkpoints", () => {
  withStore((store) => {
    const encoded = envelope(1n);
    remote(store, [encoded]);
    const recorded = rows(store);
    expect(recorded[0]).toMatchObject({
      encoded,
      source: "remote",
      verificationState: "accepted",
    });
    expect(recorded[0]?.rejectionReason).toBeNull();
    expectFrontierOne(store);
  });
});

test("treats duplicate envelopes as idempotent", () => {
  withStore((store) => {
    const duplicate = envelope(1n);
    remote(store, Array(3).fill(duplicate));
    expectStates(store, ["accepted"]);
    expect(store.state("owner-1", "non-session").projection.join(",")).toBe(
      "owner-1-1",
    );
  });
});

test("quarantines malformed envelopes while applying valid peers", () => {
  withStore((store) => {
    remote(store, ["not-json", envelope(1n)]);
    const recorded = rows(store);
    expectStates(store, ["rejected", "accepted"]);
    expect(recorded[0]?.rejectionReason).toBeTruthy();
    expectFrontierOne(store);
  });
});

test("quarantines decoded remote intake rejection and continues", () => {
  withStore((store) => {
    const operation = testOperation("owner-1", 1n, {}, "poison", 1);
    const wrongPartition = encodeOperationEnvelope({
      ...operation,
      partition: "session",
      entity: { ...operation.entity, accountId: "owner-1" },
    });
    remote(store, [wrongPartition, envelope(1n)]);
    expectStates(store, ["rejected", "accepted"]);
    expect(rows(store)[0]?.rejectionReason).toContain("partition");
    expectFrontierOne(store);
  });
});

test("quarantines equivocation without rolling back accepted peers", () => {
  withStore((store) => {
    const first = envelope(1n);
    remote(store, [first]);
    expect(() => {
      remote(store, [envelope(2n), envelope(1n, "equivocation")]);
    }).not.toThrow();
    expectStates(store, ["accepted", "accepted", "rejected"]);
    expect(store.state("owner-1", "non-session").frontier).toEqual({
      "owner-1": 2n,
    });
  });
});

test("rolls back the whole batch after a genuine storage failure", () => {
  withStore((store, database) => {
    database.run(
      "CREATE TRIGGER fail_second_operation BEFORE INSERT ON operation_envelopes WHEN NEW.sequence = '2' BEGIN SELECT RAISE(ABORT, 'storage fault'); END",
    );
    expect(() => {
      remote(store, [envelope(1n), envelope(2n)]);
    }).toThrow("storage fault");
    expect(rows(store)).toEqual([]);
    expect(Object.keys(store.state("owner-1", "non-session").frontier)).toEqual(
      [],
    );
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
