export interface SessionCommandCall {
  readonly operation: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function recordingCommand(
  calls: SessionCommandCall[],
  operation: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  calls.push({ operation, payload });
}
