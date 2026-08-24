interface QueuedCommand {
  readonly id: string;
}

export interface RunnerCommandDelivery<
  Pending extends { readonly command: QueuedCommand },
> {
  readonly next: (
    runnerId: string,
    excludedCommandIds?: ReadonlySet<string>,
  ) => Pending | undefined;
  readonly remove: (runnerId: string, commandId: string) => void;
  readonly requeue: (runnerId: string, command: QueuedCommand) => void;
}

export function createRunnerCommandDelivery<
  Pending extends { readonly command: QueuedCommand },
>(
  pending: (commandId: string) => Pending | undefined,
): RunnerCommandDelivery<Pending> {
  const queues = new Map<string, QueuedCommand[]>();

  function removeEmpty(
    runnerId: string,
    queue: readonly QueuedCommand[],
  ): void {
    if (queue.length === 0) queues.delete(runnerId);
  }

  function requeue(runnerId: string, command: QueuedCommand): void {
    const queue = queues.get(runnerId) ?? [];
    queue.unshift(command);
    queues.set(runnerId, queue);
  }

  function next(
    runnerId: string,
    excludedCommandIds?: ReadonlySet<string>,
  ): Pending | undefined {
    const queue = queues.get(runnerId);
    if (queue === undefined) return undefined;

    for (let index = 0; index < queue.length; index += 1) {
      const command = queue[index];
      if (command === undefined) continue;
      const queued = pending(command.id);
      if (queued === undefined) {
        queue.splice(index, 1);
        index -= 1;
        continue;
      }
      if (excludedCommandIds?.has(command.id) === true) continue;
      queue.splice(index, 1);
      removeEmpty(runnerId, queue);
      return queued;
    }
    removeEmpty(runnerId, queue);
    return undefined;
  }

  function remove(runnerId: string, commandId: string): void {
    const queue = queues.get(runnerId);
    if (queue === undefined) return;
    const index = queue.findIndex(({ id }) => id === commandId);
    if (index >= 0) queue.splice(index, 1);
    removeEmpty(runnerId, queue);
  }

  return { next, remove, requeue };
}
