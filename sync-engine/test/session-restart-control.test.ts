import { describe, expect, test } from "vitest";
import {
  createSessionRestartControl,
  readSessionRestartCredential,
} from "../../sync-engine/session-restart-control.ts";
import { SessionRuntimes } from "../../sync-engine/session-runtime.ts";

const CREDENTIAL = {
  accountId: "account",
  id: "credential",
  isDefault: false,
  label: "Key",
  secret: "secret",
  source: "api_key" as const,
};

describe("session restart control", () => {
  test("reuses one server restart ID across repeated drains", async () => {
    const runtimes = new SessionRuntimes();
    let generated = 0;
    const restart = createSessionRestartControl(runtimes, () => {
      generated += 1;
      return `server-${String(generated)}`;
    });

    await restart.drainServer();
    await restart.drainServer();

    expect(generated).toBe(1);
    expect(runtimes.drainRequest({ kind: "server" })?.restartId).toBe(
      "server-1",
    );
  });

  test("rejects invalid generated server restart IDs", () => {
    const restart = createSessionRestartControl(new SessionRuntimes(), () =>
      "x".repeat(201),
    );

    expect(() => restart.drainServer()).toThrow("ID is invalid");
  });

  test("uses a server-wide handoff when runner drain overlaps it", async () => {
    const runtimes = new SessionRuntimes();
    const restart = createSessionRestartControl(runtimes, () => "server-1");

    await restart.drainServer();
    await restart.drainRunner("runner-1", "runner-1");

    expect(
      runtimes.drainRequest({ kind: "runner", runnerId: "runner-1" }),
    ).toBe(undefined);
  });

  test("treats credential refresh failures as temporarily unavailable", async () => {
    const readers = {
      openai: {
        readCredential: () => Promise.reject(new Error("refresh failed")),
      },
      openrouter: { readCredential: () => CREDENTIAL },
    };

    await expect(
      readSessionRestartCredential(readers, "user", {
        credentialId: "credential",
        provider: "openai",
      }),
    ).resolves.toBeUndefined();
    await expect(
      readSessionRestartCredential(readers, "user", {
        credentialId: "credential",
        provider: "openrouter",
      }),
    ).resolves.toBe(CREDENTIAL);
  });
});
