type RunnerProcessCommit = () => void;

export interface RunnerCommandSurvivalOptions {
  readonly log?: (message: string) => void;
  readonly maximumCancellationTombstones?: number;
}

export interface RunnerCommandSurvivalState {
  readonly acknowledgeCancellation: (
    runnerId: string,
    commandId: string,
  ) => boolean;
  readonly deliverCancellations: (
    runnerId: string,
    deliver: (commandId: string) => boolean,
  ) => boolean;
  readonly processMatches: (runnerId: string, processNonce: string) => boolean;
  readonly recordCancellation: (runnerId: string, commandId: string) => void;
  readonly stageProcess: (
    runnerId: string,
    processNonce?: string,
  ) => RunnerProcessCommit;
}

export function createRunnerCommandSurvivalState(
  options: RunnerCommandSurvivalOptions = {},
): RunnerCommandSurvivalState {
  const cancellationTombstones = new Map<string, Set<string>>();
  const log = options.log ?? console.error;
  const maximumCancellationTombstones =
    options.maximumCancellationTombstones ?? 1_000;
  const runnerProcessNonces = new Map<string, string | undefined>();
  if (
    !Number.isSafeInteger(maximumCancellationTombstones) ||
    maximumCancellationTombstones < 1
  ) {
    throw new RangeError(
      "The runner cancellation tombstone limit must be positive",
    );
  }

  const processMatches = (runnerId: string, processNonce: string): boolean =>
    runnerProcessNonces.has(runnerId) &&
    runnerProcessNonces.get(runnerId) === processNonce;

  return {
    acknowledgeCancellation(runnerId, commandId) {
      const tombstones = cancellationTombstones.get(runnerId);
      if (tombstones?.delete(commandId) !== true) return false;
      if (tombstones.size === 0) cancellationTombstones.delete(runnerId);
      return true;
    },
    deliverCancellations(runnerId, deliver) {
      const tombstones = cancellationTombstones.get(runnerId);
      if (tombstones === undefined) return true;
      for (const commandId of tombstones) if (!deliver(commandId)) return false;
      return true;
    },
    processMatches,
    recordCancellation(runnerId, commandId) {
      const tombstones = cancellationTombstones.get(runnerId) ?? new Set();
      tombstones.delete(commandId);
      tombstones.add(commandId);
      cancellationTombstones.set(runnerId, tombstones);
      let count = 0;
      for (const entries of cancellationTombstones.values())
        count += entries.size;
      if (count <= maximumCancellationTombstones) return;
      for (const [discardedRunnerId, entries] of cancellationTombstones) {
        const discarded = entries.values().next().value;
        if (discarded === undefined) continue;
        entries.delete(discarded);
        if (entries.size === 0)
          cancellationTombstones.delete(discardedRunnerId);
        log(
          `Q Mush discarded an unacknowledged runner cancellation tombstone for ${discarded} after reaching the safety limit.`,
        );
        return;
      }
    },
    stageProcess(runnerId, processNonce) {
      const sameProcess =
        processNonce !== undefined && processMatches(runnerId, processNonce);
      return () => {
        if (!sameProcess) {
          runnerProcessNonces.set(runnerId, processNonce);
          cancellationTombstones.delete(runnerId);
        }
      };
    },
  };
}
