export const MAXIMUM_PENDING_COMMANDS = 1_000;
export const MAXIMUM_PENDING_COMMAND_BYTES = 128 * 1024 * 1024;
export const UNKNOWN_OUTCOME_ERROR = "outcome_unknown";

export interface PendingCommand {
  readonly bytes: number;
  readonly envelope: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  sentInstanceId: string | undefined;
}

export interface QueuedCommand {
  readonly commandId: string;
  readonly pending: PendingCommand;
}

export function normalizedCommandError(error: string): string {
  return error === "command_outcome_unknown" || error === UNKNOWN_OUTCOME_ERROR
    ? UNKNOWN_OUTCOME_ERROR
    : error;
}

export function commandFailure(
  code: string,
  detail?: string,
): Error & { readonly code: string } {
  return Object.assign(new Error(detail ?? code), { code });
}
