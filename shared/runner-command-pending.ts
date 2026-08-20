import type { RunnerCommandDelivery } from "./runner-command-delivery.ts";
import type {
  RunnerCommandStream,
  RunnerToolCommand,
} from "./runner-command.ts";
import type { RunnerCommandResult } from "./tool-stream.ts";

export interface PendingRunnerCommand {
  readonly abort: (() => void) | undefined;
  readonly authorize: (() => boolean) | undefined;
  readonly command: RunnerToolCommand;
  connectionGeneration: number | undefined;
  readonly generation: number | undefined;
  readonly reject: (error: Error) => void;
  readonly resolve: (result: RunnerCommandResult) => void;
  readonly runnerId: string;
  readonly signal: AbortSignal | undefined;
  readonly stream: RunnerCommandStream | undefined;
  nextSequence: number;
  phase: "in_flight" | "queued";
  queuedAfterDisconnect: boolean;
}

export function abortRunnerCommand(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export function ignoreRunnerCommandCleanupError(callback: () => void): void {
  try {
    callback();
  } catch {
    // The broker has already fenced the command; cleanup is best effort.
  }
}

export function matchingRunnerCommands(
  pending: ReadonlyMap<string, PendingRunnerCommand>,
  matches: (command: PendingRunnerCommand) => boolean,
): PendingRunnerCommand[] {
  return Array.from(pending.values()).filter(matches);
}

export function settlePendingRunnerCommand(
  pendingCommands: Map<string, PendingRunnerCommand>,
  delivery: RunnerCommandDelivery<PendingRunnerCommand>,
  commandId: string,
  pending: PendingRunnerCommand,
): void {
  pendingCommands.delete(commandId);
  if (pending.abort !== undefined && pending.signal !== undefined) {
    const abort = pending.abort;
    const signal = pending.signal;
    ignoreRunnerCommandCleanupError(() => {
      signal.removeEventListener("abort", abort);
    });
  }
  if (pending.phase === "queued") {
    delivery.remove(pending.runnerId, commandId);
  }
}
