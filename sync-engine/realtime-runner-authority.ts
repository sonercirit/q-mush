import { isRecord } from "../shared/auth-model.ts";
import {
  RUNNER_SUPERSEDED_CLOSE_CODE,
  runnerSupersededMessage,
} from "../shared/runner-realtime-protocol.ts";
import type { RealtimeSocket } from "./realtime-hub.ts";
import {
  closeServerError,
  safeSend,
  type PendingRunnerRegistration,
  type RunnerSocketData,
} from "./realtime-runner-runtime.ts";
import type { RealtimeRegistrationDependencies } from "./realtime-runner-types.ts";
import { withCurrentPendingRunner } from "./realtime-runner-with-current.ts";
import type { RunnerConnection } from "./runner-store.ts";

interface RunnerSocketAuthority {
  fence(): void;
  readonly runnerId: string | undefined;
  readonly usable: boolean;
}

function runnerSocketAuthority(
  socket: RealtimeSocket,
): RunnerSocketAuthority | undefined {
  const data: unknown = Reflect.get(socket, "data");
  if (
    !isRecord(data) ||
    data["kind"] !== "runner" ||
    typeof data["fenced"] !== "boolean" ||
    typeof data["usable"] !== "boolean"
  ) {
    return undefined;
  }
  const runner = data["runner"];
  const runnerId = isRecord(runner) ? runner["id"] : undefined;
  if (!(runnerId === undefined || typeof runnerId === "string")) {
    return undefined;
  }
  return {
    fence: () => {
      data["fenced"] = true;
      data["runner"] = undefined;
      data["usable"] = false;
    },
    runnerId,
    usable: data["usable"],
  };
}

function clearRunnerRegistration(data: RunnerSocketData): void {
  data.committed = undefined;
  data.registration = undefined;
  data.runner = undefined;
  data.usable = false;
  data.fenced = true;
}

export function fenceRunnerRegistration(
  socket: RealtimeSocket,
  data: RunnerSocketData,
  reason: string,
): void {
  clearRunnerRegistration(data);
  closeServerError(socket, reason);
}

export function registrationChanged(
  socket: RealtimeSocket,
  data: RunnerSocketData,
): void {
  clearRunnerRegistration(data);
  socket.close(1008, "Registration changed");
}

function requireCurrentPendingRunner(
  options: RealtimeRegistrationDependencies,
  pending: PendingRunnerRegistration,
  socket: RealtimeSocket,
  validate = false,
): RunnerConnection | undefined {
  const runner = withCurrentPendingRunner([options, pending, socket]);
  if (validate && runner === undefined) {
    return undefined;
  }
  return runner;
}

export function restorePreviousRunnerAuthority(
  options: RealtimeRegistrationDependencies,
  pending: PendingRunnerRegistration,
  socket: RealtimeSocket,
): void {
  const runner = requireCurrentPendingRunner(options, pending, socket);
  if (runner === undefined) {
    return;
  }
  options.hub.setRunner(runner.id, socket, false);
  const previous = pending.previousAuthority;
  const previousAuthority =
    previous === undefined ? undefined : runnerSocketAuthority(previous);
  if (
    previous !== undefined &&
    previousAuthority?.runnerId === runner.id &&
    previousAuthority.usable
  ) {
    options.hub.setRunner(runner.id, previous, true);
  }
}

export function establishPendingRunnerAuthority(
  options: RealtimeRegistrationDependencies,
  pending: PendingRunnerRegistration,
  socket: RealtimeSocket,
  data: RunnerSocketData,
): boolean {
  const runner = pending.committed;
  if (runner === undefined) {
    return false;
  }
  const previous = options.hub.currentRunner(runner.id);
  pending.previousAuthority =
    previous === undefined || previous === socket ? undefined : previous;
  options.hub.setRunner(runner.id, socket, true);
  data.runner = runner;
  data.usable = false;
  return options.hub.runnerIsCurrent(runner.id, socket);
}

function notifySupersededRunner(socket: RealtimeSocket): void {
  safeSend(socket, runnerSupersededMessage());
  try {
    socket.close(
      RUNNER_SUPERSEDED_CLOSE_CODE,
      "Superseded by a newer runner process",
    );
  } catch {
    // Hub authority already fences the superseded socket.
  }
}

function fenceReplacedSocket(
  replaced: RealtimeSocket | undefined,
  socket: RealtimeSocket,
): void {
  if (replaced === undefined || replaced === socket) {
    return;
  }
  runnerSocketAuthority(replaced)?.fence();
  notifySupersededRunner(replaced);
}

export function finishRunnerOperational(
  options: RealtimeRegistrationDependencies,
  publishRunners: (userId: string) => void,
  socket: RealtimeSocket,
  data: RunnerSocketData,
  pending: PendingRunnerRegistration,
): void {
  const runner = requireCurrentPendingRunner(options, pending, socket, true);
  if (runner === undefined) {
    if (!data.fenced) {
      socket.close(1008, "Runner connection was replaced");
    }
    return;
  }
  data.usable = true;
  const replaced = pending.previousAuthority;
  const replacedGeneration = options.sessions.runnerConnectionGeneration(
    runner.id,
  );
  const connectionGeneration =
    replaced === undefined ? replacedGeneration : replacedGeneration + 1;
  const isCurrent = () =>
    data.usable &&
    options.hub.runnerIsCurrent(runner.id, socket) &&
    options.hub.currentRunner(runner.id) === socket;
  const deliver = (command: Parameters<typeof options.sendCommand>[1]) =>
    isCurrent() ? options.sendCommand(socket, command) : false;
  const deliverCancellation = (commandId: string) =>
    isCurrent()
      ? safeSend(socket, JSON.stringify({ commandId, type: "cancel" }))
      : false;
  let delivered = false;
  try {
    delivered = options.sessions.deliverRunnerCommands({
      connectionGeneration,
      deliver,
      deliverCancellation,
      processNonce: pending.processNonce,
      runnerId: runner.id,
    });
  } catch {
    // The replacement remains provisional until queued delivery succeeds.
  }
  if (!delivered) {
    data.usable = false;
    restorePreviousRunnerAuthority(options, pending, socket);
    data.runner = undefined;
    fenceRunnerRegistration(socket, data, "Runner command delivery failed");
    return;
  }
  options.sessions.commitRunnerProcess(runner.id, pending.processNonce);
  if (replaced !== undefined) {
    options.sessions.replaceRunnerConnection(runner.id, replacedGeneration);
  }
  options.sessions.runnerOperational(
    runner.id,
    pending.gate.lifecycle === "restart"
      ? pending.gate.expectedRestartId
      : undefined,
  );
  data.committed = undefined;
  data.registration = undefined;
  fenceReplacedSocket(replaced, socket);
  publishRunners(runner.userId);
}
