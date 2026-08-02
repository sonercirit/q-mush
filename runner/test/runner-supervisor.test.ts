import { expect, test } from "vitest";
import { superviseRunner } from "../../runner/runner-supervisor.ts";

const SUPERVISOR_STOP = new Error("supervisor test stopped");

test("relaunches the stable runner after a bounded delay", async () => {
  const launches: string[][] = [];
  const logs: string[] = [];
  const delays: number[] = [];
  const processResults = [Promise.resolve(1), Promise.resolve(0)];

  await expect(
    superviseRunner("/runner/q-mush-runner", "/runner/config", {
      delay: (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 2) {
          throw SUPERVISOR_STOP;
        }
        return Promise.resolve();
      },
      launch: (executable, arguments_) => {
        launches.push([executable, ...arguments_]);
        const result = processResults.shift();
        if (result === undefined) {
          throw new Error("The supervisor launched too many runners");
        }
        return { kill: () => true, result };
      },
      log: (message) => {
        logs.push(message);
      },
      onSignal: () => undefined,
      removeSignalListener: () => undefined,
    }),
  ).rejects.toBe(SUPERVISOR_STOP);

  expect(launches).toEqual([
    ["/runner/q-mush-runner", "--config", "/runner/config"],
    ["/runner/q-mush-runner", "--config", "/runner/config"],
  ]);
  expect(delays).toEqual([5_000, 5_000]);
  expect(logs).toEqual([
    "Q Mush runner exited with status 1; restarting in 5 seconds.",
    "Q Mush runner exited with status 0; restarting in 5 seconds.",
  ]);
});

test("forwards termination to the active runner", async () => {
  const result = Promise.withResolvers<number>();
  const signals = new Map<NodeJS.Signals, () => void>();
  const killed: (NodeJS.Signals | undefined)[] = [];
  const process = {
    kill: (signal?: NodeJS.Signals) => (
      killed.push(signal),
      result.resolve(0),
      true
    ),
    result: result.promise,
  };

  const supervision = superviseRunner("/runner", "/config", {
    delay: () => Promise.reject(SUPERVISOR_STOP),
    launch: () => process,
    log: () => undefined,
    onSignal: (signal, listener) => {
      signals.set(signal, listener);
    },
    removeSignalListener: (signal) => {
      signals.delete(signal);
    },
  });
  signals.get("SIGTERM")?.();

  await expect(supervision).rejects.toBe(SUPERVISOR_STOP);
  expect(killed).toEqual(["SIGTERM"]);
  expect(signals.size).toBe(0);
});
