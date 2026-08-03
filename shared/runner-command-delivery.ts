interface QueuedCommand {
  readonly id: string;
}

export class RunnerCommandDelivery<
  Pending extends { readonly command: QueuedCommand },
> {
  readonly #pending: (commandId: string) => Pending | undefined;
  readonly #queues = new Map<string, QueuedCommand[]>();

  constructor(pending: (commandId: string) => Pending | undefined) {
    this.#pending = pending;
  }

  requeue(runnerId: string, command: QueuedCommand): void {
    const queue = this.#queues.get(runnerId) ?? [];
    queue.unshift(command);
    this.#queues.set(runnerId, queue);
  }

  #queue(runnerId: string): QueuedCommand[] | undefined {
    return this.#queues.get(runnerId);
  }

  next(
    runnerId: string,
    excludedCommandIds?: ReadonlySet<string>,
  ): Pending | undefined {
    const queue = this.#queue(runnerId);
    if (queue === undefined) return undefined;

    for (let index = 0; index < queue.length; index += 1) {
      const command = queue[index];
      if (command === undefined) continue;
      const pending = this.#pending(command.id);
      if (pending === undefined) {
        queue.splice(index, 1);
        index -= 1;
        continue;
      }
      if (excludedCommandIds?.has(command.id) === true) continue;
      queue.splice(index, 1);
      this.#removeEmpty(runnerId, queue);
      return pending;
    }
    this.#removeEmpty(runnerId, queue);
    return undefined;
  }

  remove(runnerId: string, commandId: string): void {
    const queue = this.#queue(runnerId);
    if (queue === undefined) return;
    const index = queue.findIndex(({ id }) => id === commandId);
    if (index >= 0) queue.splice(index, 1);
    this.#removeEmpty(runnerId, queue);
  }

  #removeEmpty(runnerId: string, queue: readonly QueuedCommand[]): void {
    if (queue.length === 0) {
      this.#queues.delete(runnerId);
    }
  }
}
