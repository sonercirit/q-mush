interface RunnerCommandSurvivalOptions {
  readonly log?: (message: string) => void;
  readonly maximumCancellationTombstones?: number;
}

export class RunnerCommandSurvivalState {
  readonly #cancellationTombstones = new Map<string, Set<string>>();
  readonly #log: (message: string) => void;
  readonly #maximumCancellationTombstones: number;
  readonly #runnerProcessNonces = new Map<string, string | undefined>();

  constructor(options: RunnerCommandSurvivalOptions = {}) {
    const maximumCancellationTombstones =
      options.maximumCancellationTombstones ?? 1_000;
    if (
      !Number.isSafeInteger(maximumCancellationTombstones) ||
      maximumCancellationTombstones < 1
    ) {
      throw new RangeError(
        "The runner cancellation tombstone limit must be positive",
      );
    }
    this.#log = options.log ?? console.error;
    this.#maximumCancellationTombstones = maximumCancellationTombstones;
  }

  deliverCancellations(
    runnerId: string,
    deliver: (commandId: string) => boolean,
  ): boolean {
    const tombstones = this.#cancellationTombstones.get(runnerId);
    if (tombstones === undefined) {
      return true;
    }
    for (const commandId of tombstones) {
      if (!deliver(commandId)) {
        return false;
      }
    }
    return true;
  }

  acknowledgeCancellation(runnerId: string, commandId: string): boolean {
    const tombstones = this.#cancellationTombstones.get(runnerId);
    if (tombstones?.delete(commandId) !== true) {
      return false;
    }
    if (tombstones.size === 0) {
      this.#cancellationTombstones.delete(runnerId);
    }
    return true;
  }

  observeProcess(runnerId: string, processNonce?: string): boolean {
    const sameProcess =
      processNonce !== undefined &&
      this.#runnerProcessNonces.has(runnerId) &&
      this.#runnerProcessNonces.get(runnerId) === processNonce;
    if (!sameProcess) {
      this.#runnerProcessNonces.set(runnerId, processNonce);
      this.#cancellationTombstones.delete(runnerId);
    }
    return sameProcess;
  }

  recordCancellation(runnerId: string, commandId: string): void {
    const tombstones = this.#cancellationTombstones.get(runnerId) ?? new Set();
    tombstones.delete(commandId);
    tombstones.add(commandId);
    this.#cancellationTombstones.set(runnerId, tombstones);
    if (
      this.#cancellationTombstoneCount() <= this.#maximumCancellationTombstones
    ) {
      return;
    }
    for (const [discardedRunnerId, discardedTombstones] of this
      .#cancellationTombstones) {
      const discarded = discardedTombstones.values().next().value;
      if (discarded === undefined) {
        continue;
      }
      discardedTombstones.delete(discarded);
      if (discardedTombstones.size === 0) {
        this.#cancellationTombstones.delete(discardedRunnerId);
      }
      this.#log(
        `Q Mush discarded an unacknowledged runner cancellation tombstone for ${discarded} after reaching the safety limit.`,
      );
      return;
    }
  }

  #cancellationTombstoneCount(): number {
    let count = 0;
    for (const tombstones of this.#cancellationTombstones.values()) {
      count += tombstones.size;
    }
    return count;
  }
}
