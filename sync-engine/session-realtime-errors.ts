import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";

export function credentialUnavailable(): RealtimeCommandError {
  return new RealtimeCommandError("credential_unavailable");
}

export function requireCredentialCandidates(
  credentials: readonly ProviderCredentialAccess[],
): void {
  if (credentials.length === 0) throw credentialUnavailable();
}

function throwLastCredentialFailure(failure: unknown): never {
  throw failure instanceof Error ? failure : credentialUnavailable();
}

export function successfulCredentialAttempt<Result>(
  promise: Promise<Result>,
): Promise<Result> {
  return promise.catch((error: unknown) => throwLastCredentialFailure(error));
}

export async function requireJsonResponse(response: Response): Promise<void> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new RealtimeCommandError("command_failed");
  }
  if (response.ok) return;
  if (typeof value === "object" && value !== null && "error" in value) {
    const error: unknown = value.error;
    if (typeof error === "string") throw new RealtimeCommandError(error);
  }
  throw new RealtimeCommandError("command_failed");
}
