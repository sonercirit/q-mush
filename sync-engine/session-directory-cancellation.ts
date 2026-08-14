import { abortSignalError } from "../shared/validation.ts";

export function directoryUnavailable(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortSignalError(signal, "Directory browsing was canceled");
  }
}
