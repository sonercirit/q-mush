import { expect, test, vi } from "vitest";
import { DatabaseWriteResilience } from "../database-write-resilience.ts";
import { EngineHealth } from "../engine-health.ts";

function diskFullError(): Error & { readonly code: string } {
  return Object.assign(new Error("database or disk is full"), {
    code: "SQLITE_FULL",
  });
}

function injectedWrite(operation: () => void): () => void {
  return operation;
}

test("drops an injected non-critical full-disk write and degrades health", () => {
  const health = new EngineHealth(vi.fn());
  const resilience = new DatabaseWriteResilience({ health });
  const write = injectedWrite(() => {
    throw diskFullError();
  });

  resilience.run("noncritical", write);

  expect(health.snapshot().reasons.join(",")).toBe("disk_full");
  expect(health.snapshot().degraded).toBe(true);
});

test("retries an injected critical write when space returns", () => {
  const health = new EngineHealth(vi.fn());
  const retries: (() => void)[] = [];
  const nativeTimer = setTimeout(() => undefined, 60_000);
  clearTimeout(nativeTimer);
  const resilience = new DatabaseWriteResilience({
    health,
    setTimeout: (callback) => {
      retries.push(callback);
      return nativeTimer;
    },
  });
  let available = false;
  let writes = 0;
  const write = injectedWrite(() => {
    writes += 1;
    if (!available) {
      throw diskFullError();
    }
  });

  resilience.run("critical", write);
  expect(retries).toHaveLength(1);
  available = true;
  retries.shift()?.();

  expect(writes).toBe(2);
  expect(health.snapshot()).not.toMatchObject({ degraded: true });
});
