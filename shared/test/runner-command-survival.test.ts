import { describe, expect, test } from "vitest";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { createRunnerDisconnectedError } from "../../shared/runner-disconnected-error.ts";
import { captureBrokerRejection } from "./promise-test-helpers.ts";
import {
  brokerRunnerCommand,
  completedRunnerCommand,
  deliveredBroker,
  expectRunnerCommandAbort,
  expectUnauthorizedRunnerCommand,
  TEST_RUNNER_ID,
  TEST_SESSION_ID,
} from "./runner-command-broker-fixtures.ts";

const RUNNER_ID = TEST_RUNNER_ID;
const SESSION_ID = TEST_SESSION_ID;

async function expectCompletedResult(
  broker: RunnerCommandBroker,
  result: Promise<ReturnType<typeof completedRunnerCommand>>,
  commandId: string,
  output: string,
): Promise<void> {
  expect(
    broker.complete(RUNNER_ID, commandId, completedRunnerCommand(output)),
  ).toBe(true);
  await expect(result).resolves.toEqual(completedRunnerCommand(output));
}

test("cancels only commands from a revoked execution generation", async () => {
  const canceled: string[] = [];
  let id = 0;
  const broker = new RunnerCommandBroker({
    cancel: (_runnerId, commandId) => canceled.push(commandId),
    commandId: () => `generation-${String(++id)}`,
    deliver: () => true,
  });
  const old = broker.dispatch(brokerRunnerCommand({ generation: 3 }));
  const current = broker.dispatch(brokerRunnerCommand({ generation: 4 }));

  expect(broker.cancelSessionGeneration(SESSION_ID, 3)).toHaveLength(1);
  expectRunnerCommandAbort(await captureBrokerRejection(old));
  expect(canceled).toEqual(["generation-1"]);
  expect(
    broker.complete(
      RUNNER_ID,
      "generation-2",
      completedRunnerCommand("current"),
    ),
  ).toBe(true);
  expect(await current).toEqual(completedRunnerCommand("current"));
});

function recordCancellation(
  broker: RunnerCommandBroker,
  canceled: string[],
): boolean {
  return broker.deliverCancellationTombstones(RUNNER_ID, (commandId) => {
    canceled.push(commandId);
    return true;
  });
}

function disconnectedDispatch(commandId: string, processNonce?: string) {
  const broker = deliveredBroker(commandId);
  if (processNonce !== undefined) {
    broker.registerRunnerProcess(RUNNER_ID, processNonce);
  }
  const result = broker.dispatch(brokerRunnerCommand());
  broker.disconnectRunner(RUNNER_ID);
  return { broker, result };
}

describe("runner command disconnect survival", () => {
  test("delivers cancellation after a disconnected command is stopped", async () => {
    const canceled: string[] = [];
    const { broker, result } = disconnectedDispatch("cancel-after-disconnect");

    broker.cancelSessionCommands(SESSION_ID);

    await expectUnauthorizedRunnerCommand(result);
    expect(recordCancellation(broker, canceled)).toBe(true);
    expect(canceled.join(",")).toBe("cancel-after-disconnect");
    expect(
      broker.acknowledgeCancellation(RUNNER_ID, "cancel-after-disconnect"),
    ).toBe(true);
    canceled.length = 0;
    expect(recordCancellation(broker, canceled)).toBe(true);
    expect(canceled).toHaveLength(0);
  });

  test("fails disconnected commands instead of redelivering them to a fresh process", async () => {
    const { broker, result } = disconnectedDispatch(
      "lost-process-command",
      "process-old",
    );

    expect(broker.registerRunnerProcess(RUNNER_ID, "process-fresh")).toBe(
      false,
    );

    await expect(result).rejects.toEqual(
      createRunnerDisconnectedError(
        "The runner process restarted before the command returned",
      ),
    );
    expect(broker.take(RUNNER_ID)).toBeUndefined();
  });

  test("redelivers disconnected commands only to the same process nonce", async () => {
    const { broker, result } = disconnectedDispatch(
      "same-process-command",
      "process-same",
    );

    expect(broker.registerRunnerProcess(RUNNER_ID, "process-same")).toBe(true);
    expect(broker.take(RUNNER_ID)?.id).toBe("same-process-command");
    await expectCompletedResult(
      broker,
      result,
      "same-process-command",
      "survived",
    );
  });
});
