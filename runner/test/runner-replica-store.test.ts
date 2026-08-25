import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createRunnerReplicaStore } from "../../runner/runner-replica-store.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const createTemporaryDirectory = useTemporaryDirectories("q-mush-replica-");

describe("runner full replica store", () => {
  test("requires all records, tombstones, manifest, and blobs before ready", async () => {
    const directory = await createTemporaryDirectory();
    const store = createRunnerReplicaStore(directory);
    const bytes = new TextEncoder().encode("attachment bytes");
    store.begin({
      availableBytes: 1_000,
      requiredBytes: bytes.byteLength,
    });
    store.applyRecords([
      { entity: "agent_sessions", id: "s1", payload: "{}", tombstone: false },
    ]);
    store.setFrontier("frontier-1");
    store.setManifest([
      {
        digest: Bun.CryptoHasher.hash("sha256", bytes, "hex"),
        size: bytes.byteLength,
      },
    ]);
    expect(store.progress().state).toBe("joining");
    writeFileSync(join(directory, "incoming"), bytes);
    await store.installBlob(join(directory, "incoming"));
    expect(store.progress()).toMatchObject({
      state: "ready",
      records: 1,
      tombstones: 0,
    });
    store.close();
  });

  test("serves bounded active views only after the full replica is ready", async () => {
    const store = createRunnerReplicaStore(await createTemporaryDirectory());
    store.applyRecords([
      {
        entity: "agent_sessions",
        id: "s1",
        payload: JSON.stringify({
          id: "s1",
          title: "First",
          is_deleted: false,
        }),
        tombstone: false,
      },
      {
        entity: "agent_messages",
        id: "m1",
        payload: JSON.stringify({
          id: "m1",
          session_id: "s1",
          content: "hello",
        }),
        tombstone: false,
      },
      { entity: "agent_sessions", id: "gone", payload: "{}", tombstone: true },
    ]);
    expect(() => store.readView("agent_sessions", 10)).toThrow("joining");
    store.setFrontier("frontier");
    store.setManifest([]);
    expect(store.readView("agent_sessions", 1)).toEqual({
      complete: true,
      partial: true,
      records: [{ id: "s1", title: "First", is_deleted: false }],
    });
    expect(store.readView("agent_messages", 10, "s1")).toMatchObject({
      records: [{ id: "m1", content: "hello" }],
    });
    store.close();
  });

  test("rejects catch-up when capacity reserve is insufficient", async () => {
    const directory = await createTemporaryDirectory();
    mkdirSync(directory, { recursive: true });
    const store = createRunnerReplicaStore(directory);
    expect(() => {
      store.begin({ availableBytes: 9, requiredBytes: 10 });
    }).toThrow("capacity");
    store.close();
  });
});
