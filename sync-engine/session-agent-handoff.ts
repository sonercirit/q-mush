export function restartHandoffResult(
  signal: AbortSignal | undefined,
  handoffRequested: (() => boolean) | undefined,
  result: "complete" | "handoff",
): "complete" | "handoff" | undefined {
  if (signal?.aborted === true) {
    signal.throwIfAborted();
  }
  return handoffRequested?.() === true ? result : undefined;
}
