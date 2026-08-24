import { createRealtimeCommandFailure } from "./realtime-command-ledger.ts";
export function requiredRealtimeInput<Input>(
  input: Input | undefined,
  code: "invalid_request" | "not_found" = "invalid_request",
): Input {
  if (input === undefined) {
    throw createRealtimeCommandFailure(code);
  }
  return input;
}
