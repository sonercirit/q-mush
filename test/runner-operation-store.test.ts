import { Database } from "bun:sqlite";
import { expect, test } from "vitest";

import { createRunnerOperationStore } from "../runner/runner-operation-store.ts";
import {
  decodeOperationEnvelope,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint.ts";
import { MAX_OPERATION_ENVELOPE_BYTES } from "../shared/operation-core.ts";
import {
  testOperation,
  testSessionOperation,
} from "./operation-core-test-support.ts";

const ownedOperation = (operation: ReturnType<typeof testOperation>) => ({
  ...operation,
  entity: { ...operation.entity, accountId: "owner-1" },
});
const envelope = (sequence: bigint, value = `value-${String(sequence)}`) =>
  encodeOperationEnvelope(
    ownedOperation(
      testOperation("owner-1", sequence, {}, value, Number(sequence)),
    ),
  );
type Store = ReturnType<typeof createRunnerOperationStore>;
const withStore = (run: (store: Store, database: Database) => void) => {
  const database = new Database(":memory:");
  try {
    run(createRunnerOperationStore(database), database);
  } finally {
    database.close();
  }
};
const applyRemote = (
  store: Store,
  partition: "non-session" | "session",
  envelopes: readonly string[],
) => {
  store.apply("owner-1", partition, envelopes, "remote");
};
const remote = (store: Store, envelopes: readonly string[]) => {
  applyRemote(store, "non-session", envelopes);
};
const remoteSession = (store: Store, envelopes: readonly string[]) => {
  applyRemote(store, "session", envelopes);
};
const poisonEnvelope = (sequence: bigint) => {
  const operation = decodeOperationEnvelope(envelope(sequence));
  return encodeOperationEnvelope({
    ...operation,
    clock: { ...operation.clock, physicalMs: 1 },
  });
};

const rows = (store: Store) => store.inspect("owner-1", "non-session");
const verificationStates = (store: Store) =>
  rows(store).map(({ verificationState }) => verificationState);
const expectStates = (store: Store, expected: readonly string[]) => {
  expect(verificationStates(store)).toEqual(expected);
};
const expectNonSessionFrontier = (
  store: Store,
  expected: Readonly<Record<string, bigint>>,
) => {
  expect(store.state("owner-1", "non-session").frontier).toEqual(expected);
};
const expectFrontierOne = (store: Store) => {
  expectNonSessionFrontier(store, { "owner-1": 1n });
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

test("durably quarantines distinct poisons, stalls only their partition, and applies the valid prefix", () => {
  withStore((store) => {
    remote(store, [envelope(1n), "poison-one", "poison-two", envelope(2n)]);
    expectStates(store, ["accepted", "rejected", "rejected"]);
    expect(store.state("owner-1", "non-session")).toMatchObject({
      frontier: { "owner-1": 1n },
      stalled: true,
    });
    const sessionOperation = testSessionOperation(
      "owner-1",
      1n,
      "session-value",
    );
    remoteSession(store, [
      encodeOperationEnvelope({
        ...sessionOperation,
        entity: { ...sessionOperation.entity, accountId: "owner-1" },
      }),
    ]);
    expect(store.state("owner-1", "session").frontier).toEqual({
      "owner-1": 1n,
    });
  });
});

test("redelivery of one undecodable envelope remains one quarantine row", () => {
  withStore((store) => {
    for (let cycle = 0; cycle < 3; cycle += 1) remote(store, ["same-poison"]);
    expectStates(store, ["rejected"]);
    expectNonSessionFrontier(store, {});
  });
});

test("does not rewrite a checkpoint when a stalled page accepts no prefix", () => {
  withStore((store, database) => {
    remote(store, ["poison"]);
    database.run("CREATE TABLE checkpoint_writes (value INTEGER)");
    database.run(
      "CREATE TRIGGER count_checkpoint_write BEFORE UPDATE ON operation_checkpoints BEGIN INSERT INTO checkpoint_writes VALUES (1); END",
    );
    remote(store, [envelope(1n)]);
    const writes = database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM checkpoint_writes",
      )
      .get()?.count;
    expect(writes).toBe(0);
    expectNonSessionFrontier(store, {});
  });
});

test("does not advance or retain later operations across a rejected identity", () => {
  withStore((store) => {
    const poison = poisonEnvelope(2n);
    remote(store, [envelope(1n), poison, envelope(3n)]);
    expect(rows(store).filter(({ encoded }) => encoded === poison)).toEqual([
      expect.objectContaining({ verificationState: "rejected" }),
    ]);
    const state = store.state("owner-1", "non-session");
    expect(state.projection).toEqual(["owner-1-1"]);
    expect(state.pending).toEqual([]);
    expect(state.frontier).toEqual({ "owner-1": 1n });
    expect(state.stalled).toBe(true);
  });
});

test("quarantines decoded remote intake rejection and stalls", () => {
  withStore((store) => {
    const operation = testOperation("owner-1", 1n, {}, "poison", 1);
    const wrongPartition = encodeOperationEnvelope({
      ...operation,
      partition: "session",
      entity: { ...operation.entity, accountId: "owner-1" },
    });
    remote(store, [wrongPartition, envelope(1n)]);
    expectStates(store, ["rejected"]);
    expect(rows(store)[0]?.rejectionReason).toContain("partition");
    expectNonSessionFrontier(store, {});
  });
});

test("quarantines equivocation without advancing past it", () => {
  const run = (store: Store) => {
    remote(store, [envelope(1n)]);
    remote(store, [envelope(1n, "equivocation"), envelope(2n)]);
    expectStates(store, ["accepted", "rejected"]);
    expectFrontierOne(store);
  };
  withStore(run);
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

test("migrates legacy verified rows to accepted idempotently", () => {
  const database = new Database(":memory:");
  try {
    database.run(
      "CREATE TABLE operation_envelopes (owner_id TEXT NOT NULL, partition TEXT NOT NULL, operation_id TEXT NOT NULL, writer_id TEXT NOT NULL, sequence TEXT NOT NULL, encoded TEXT NOT NULL, verification_state TEXT NOT NULL, source TEXT NOT NULL, rejection_reason TEXT, outbox_pending INTEGER NOT NULL, PRIMARY KEY (owner_id, partition, operation_id), UNIQUE (owner_id, partition, writer_id, sequence))",
    );
    const encoded = envelope(1n);
    database
      .query(
        "INSERT INTO operation_envelopes VALUES (?, 'non-session', 'owner-1-1', 'owner-1', '1', ?, 'verified', 'remote', NULL, 0)",
      )
      .run("owner-1", encoded);
    expect(() => createRunnerOperationStore(database)).not.toThrow();
    const reopened = createRunnerOperationStore(database);
    expect(verificationStates(reopened)).toEqual(["accepted"]);
  } finally {
    database.close();
  }
});
test("rejects an oversized local envelope before durable queueing", () => {
  withStore((store) => {
    const oversized = envelope(1n, "x".repeat(MAX_OPERATION_ENVELOPE_BYTES));
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(
      MAX_OPERATION_ENVELOPE_BYTES,
    );
    expect(() => {
      store.apply("owner-1", "non-session", [oversized], "local");
    }).toThrow("envelope capacity");
    expect(store.pending("owner-1", "non-session")).toEqual([]);
    expect(rows(store)).toEqual([]);
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
