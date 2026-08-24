import { expect } from "vitest";
import {
  type RunnerCommandBroker,
  type RunnerCommandResult,
  type RunnerToolCommand,
  createRunnerCommandBroker,
} from "../../shared/runner-command-broker.ts";
import type { DispatchRunnerToolCommand } from "../../shared/runner-command.ts";
import { captureBrokerRejection } from "./promise-test-helpers.ts";

export const TEST_RUNNER_ID = "runner-1";
export const TEST_SESSION_ID = "session-1";

export function brokerRunnerCommand(
  overrides: Partial<DispatchRunnerToolCommand> = {},
): DispatchRunnerToolCommand {
  return {
    arguments: {},
    executionEnvironment: "bare_metal",
    runnerId: TEST_RUNNER_ID,
    sessionId: TEST_SESSION_ID,
    tool: "bash",
    workingDirectory: "/work/project",
    ...overrides,
  };
}

export function completedRunnerCommand(output: string): RunnerCommandResult {
  return { output, state: "completed" };
}

export function expectRunnerCommandAbort(value: unknown): void {
  expect(value).toMatchObject({ name: "AbortError" });
}

export async function expectUnauthorizedRunnerCommand(
  result: Promise<RunnerCommandResult>,
): Promise<void> {
  expectRunnerCommandAbort(await captureBrokerRejection(result));
}

export interface RevocableDispatch {
  readonly broker: RunnerCommandBroker;
  readonly result: Promise<RunnerCommandResult>;
  readonly revoke: () => void;
}

export function revocableRunnerDispatch(
  commandId: string,
  options: {
    readonly cancel?: (runnerId: string, commandId: string) => void;
    readonly deliver?: () => boolean;
  } = {},
): RevocableDispatch {
  let authorized = true;
  const broker = createRunnerCommandBroker({
    ...options,
    commandId: () => commandId,
  });
  return {
    broker,
    result: broker.dispatch(
      brokerRunnerCommand({ authorize: () => authorized }),
    ),
    revoke: () => {
      authorized = false;
    },
  };
}

export function deliverQueuedRunnerCommands(
  broker: RunnerCommandBroker,
  delivered: RunnerToolCommand[],
  accepted: boolean,
): void {
  broker.deliverQueued(TEST_RUNNER_ID, (command) => {
    delivered.push(command);
    return accepted;
  });
}

export interface DeliveredDispatch {
  readonly broker: RunnerCommandBroker;
  readonly result: Promise<RunnerCommandResult>;
}

export interface StreamedDispatch extends DeliveredDispatch {
  readonly streamed: unknown[];
}

export function deliveredBroker(
  commandId: string | (() => string),
  options: {
    readonly cancel?: (runnerId: string, canceledId: string) => void;
  } = {},
): RunnerCommandBroker {
  return createRunnerCommandBroker({
    ...options,
    commandId: typeof commandId === "string" ? () => commandId : commandId,
    deliver: () => true,
  });
}

export function streamedDispatch(
  commandId = "streamed-command",
  signal?: AbortSignal,
  onDelta?: (delta: { sequence: number }) => void,
): StreamedDispatch {
  const streamed: unknown[] = [];
  const broker = deliveredBroker(commandId);
  const result = broker.dispatch(brokerRunnerCommand(), signal, (delta) => {
    streamed.push(delta);
    onDelta?.(delta);
  });
  return { broker, result, streamed };
}

export function failingCleanupController(): AbortController {
  const controller = new AbortController();
  failListenerCleanup(controller);
  return controller;
}

export function failListenerCleanup(controller: AbortController): void {
  controller.signal.removeEventListener = () => {
    throw new Error("listener cleanup failed");
  };
}

export function expectBrokerInactive(
  broker: RunnerCommandBroker,
  commandId: string,
): void {
  expect(broker.take(TEST_RUNNER_ID)).toBeUndefined();
  expect(broker.isActive(TEST_RUNNER_ID, commandId)).toBe(false);
}

export function expectCommandComplete(
  broker: RunnerCommandBroker,
  commandId: string,
  output: string,
): void {
  expect(
    broker.complete(TEST_RUNNER_ID, commandId, completedRunnerCommand(output)),
  ).toBe(true);
}

export function deliveredDispatch(commandId: string): DeliveredDispatch {
  const broker = deliveredBroker(commandId);
  return { broker, result: broker.dispatch(brokerRunnerCommand()) };
}
