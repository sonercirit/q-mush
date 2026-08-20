import { expect, test } from "vitest";
import {
  boundedParallelOutput,
  executeParallelCall,
  mapWithParallelConcurrency,
} from "../../shared/parallel.ts";
import { captureBrokerRejection } from "./promise-test-helpers.ts";

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    resolve: () => {
      if (resolve === undefined) {
        throw new Error("The deferred promise was not initialized");
      }
      resolve();
    },
  };
}

function gates(count: number) {
  return Array.from({ length: count }, () => deferred());
}

test("maps a very large input through only four ordered workers", async () => {
  const itemCount = 25_000;
  const firstWave = gates(4);
  const started: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const running = mapWithParallelConcurrency(
    Array.from({ length: itemCount }, (_, index) => index),
    async (index) => {
      started.push(index);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (index < firstWave.length) {
        await firstWave[index]?.promise;
      }
      active -= 1;
      return index;
    },
  );

  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);
  for (const gate of firstWave) {
    gate.resolve();
  }

  const output = await running;
  expect(maximumActive).toBe(4);
  expect(started).toHaveLength(itemCount);
  expect(output).toHaveLength(itemCount);
  expect(output[0]).toBe(0);
  expect(output.at(-1)).toBe(itemCount - 1);
});

test("cancellation rejects before non-cooperative workers settle", async () => {
  const controller = new AbortController();
  const pending = gates(4);
  let started = 0;
  const running = mapWithParallelConcurrency(
    Array.from({ length: 10_000 }, (_, index) => index),
    async () => {
      const gate = pending[started];
      started += 1;
      if (gate === undefined) {
        throw new Error("Parallel scheduled more than its worker bound");
      }
      await gate.promise;
      return "late";
    },
    controller.signal,
  );

  await Promise.resolve();
  expect(started).toBe(4);
  controller.abort(new DOMException("stopped", "AbortError"));
  const outcome = await captureBrokerRejection(running);

  expect(outcome).toBeInstanceOf(DOMException);
  expect(started).toBe(4);
  for (const gate of pending) {
    gate.resolve();
  }
  await Promise.resolve();
  expect(started).toBe(4);
});

test("preserves each completed child for the shared final output bound", async () => {
  const firstOutput = "x".repeat(60 * 1_024);
  const pending = gates(4);
  let firstResult: unknown;
  const running = mapWithParallelConcurrency(
    Array.from({ length: 5 }, (_, index) => index),
    async (index) => {
      const result = await executeParallelCall("read", () =>
        Promise.resolve(index === 0 ? firstOutput : "ok"),
      );
      if (index === 0) {
        firstResult = result;
      }
      if (index < pending.length) {
        await pending[index]?.promise;
      }
      if (index === 4) {
        expect(firstResult).toMatchObject({ recipient_name: "read" });
        expect(JSON.stringify(firstResult)).toContain(firstOutput);
      }
      return result;
    },
  );

  await Promise.resolve();
  for (const gate of pending) {
    gate.resolve();
    await Promise.resolve();
  }
  const results = await running;
  expect(JSON.stringify(results[0])).toContain(firstOutput);
});

test("serializes high result counts without an independent byte budget", () => {
  const resultCount = 25_000;
  const output = boundedParallelOutput(
    Array.from({ length: resultCount }, () => ({
      output: "",
      recipient_name: "read",
    })),
  );
  const parsed: unknown = JSON.parse(output);

  expect(Array.isArray(parsed) ? parsed : []).toHaveLength(resultCount);
});
